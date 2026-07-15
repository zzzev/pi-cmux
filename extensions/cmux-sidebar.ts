import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_FINAL_FADE_DELAY_MS = 2500;
const CMUX_SIDEBAR_TIMEOUT_MS = 1500;
const DEFAULT_STATUS_PRIORITY = 80;

interface TokenUsageLike {
	cost?: number | { total?: number };
}

interface AssistantMessageLike {
	role: "assistant";
	usage?: TokenUsageLike;
}

function getNumberFromEnv(name: string, fallback: number): number {
	const value = process.env[name];
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getBooleanFromEnv(name: string, fallback: boolean): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	if (!value) return fallback;
	if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
	if (value === "0" || value === "false" || value === "no" || value === "off" || value === "disabled") return false;
	return fallback;
}

function sanitizeStatusKeyPart(value: string): string {
	return value.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function getStatusKey(): string {
	const configured = process.env.PI_CMUX_SIDEBAR_STATUS_KEY?.trim();
	if (configured) return configured;

	const surfaceOrTab = process.env.CMUX_SURFACE_ID || process.env.CMUX_TAB_ID || String(process.pid);
	const suffix = sanitizeStatusKeyPart(surfaceOrTab).slice(0, 64) || String(process.pid);
	return `pi-cmux-${suffix}`;
}

function hasCmuxWorkspaceContext(): boolean {
	return Boolean(process.env.CMUX_WORKSPACE_ID?.trim());
}

function isCmuxUnavailableError(text: string): boolean {
	const normalized = text.toLowerCase();
	const commandNotFound = normalized.includes("cmux") &&
		(normalized.includes("command not found") || normalized.includes("cmux: not found"));
	return normalized.includes("enoent") ||
		commandNotFound ||
		normalized.includes("no such file or directory") ||
		normalized.includes("failed to connect") ||
		normalized.includes("could not connect") ||
		normalized.includes("connection refused") ||
		normalized.includes("connection reset") ||
		normalized.includes("econnrefused") ||
		normalized.includes("econnreset") ||
		normalized.includes("socket");
}

function isAssistantMessage(message: unknown): message is AssistantMessageLike {
	return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant";
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getUsageCostTotal(cost: unknown): number {
	const direct = finiteNumber(cost);
	if (direct !== undefined) return direct;
	if (typeof cost !== "object" || cost === null) return 0;
	return finiteNumber((cost as { total?: unknown }).total) ?? 0;
}

function getBranchCost(entries: readonly unknown[]): number {
	let total = 0;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as { type?: unknown; message?: unknown };
		if (candidate.type !== "message" || !isAssistantMessage(candidate.message)) continue;
		total += getUsageCostTotal(candidate.message.usage?.cost);
	}
	return total;
}

function formatCost(cost: number): string {
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

export default function cmuxSidebarExtension(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") {
		return;
	}

	if (!getBooleanFromEnv("PI_CMUX_SIDEBAR", true) || !hasCmuxWorkspaceContext()) {
		return;
	}

	const statusKey = getStatusKey();
	const priority = getNumberFromEnv("PI_CMUX_SIDEBAR_STATUS_PRIORITY", DEFAULT_STATUS_PRIORITY);
	const finalFadeDelayMs = getNumberFromEnv(
		"PI_CMUX_SIDEBAR_FINAL_CLEAR_MS",
		getNumberFromEnv("PI_CMUX_SIDEBAR_PROGRESS_CLEAR_MS", DEFAULT_FINAL_FADE_DELAY_MS),
	);

	let runSequence = 0;
	let turnCount = 0;
	let cmuxUnavailable = false;
	let commandQueue = Promise.resolve();
	let finalFadeTimeout: ReturnType<typeof setTimeout> | undefined;
	let doneStatusText: string | undefined;

	const runCmux = async (args: string[]): Promise<void> => {
		if (cmuxUnavailable) return;
		try {
			const result = await pi.exec("cmux", args, { timeout: CMUX_SIDEBAR_TIMEOUT_MS });
			if (result.killed) return;
			if (result.code !== 0) {
				const error = result.stderr.trim() || result.stdout.trim() || `cmux exited with code ${result.code}`;
				if (isCmuxUnavailableError(error)) cmuxUnavailable = true;
			}
		} catch (error) {
			if (isCmuxUnavailableError(error instanceof Error ? error.message : String(error))) {
				cmuxUnavailable = true;
			}
		}
	};

	const enqueueCmux = (args: string[]): void => {
		if (cmuxUnavailable) return;
		commandQueue = commandQueue.then(() => runCmux(args), () => runCmux(args));
	};

	const flushCmux = async (): Promise<void> => {
		await commandQueue.catch(() => undefined);
	};

	const setStatus = (icon: string | undefined, color: string, value: string): void => {
		const args = [
			"set-status",
			statusKey,
			value,
			"--color",
			color,
			"--priority",
			String(priority),
		];
		if (icon) args.push("--icon", icon);
		enqueueCmux(args);
	};

	const clearStatus = (): void => {
		enqueueCmux(["clear-status", statusKey]);
	};

	const clearProgress = (): void => {
		enqueueCmux(["clear-progress"]);
	};

	const getContextPercent = (
		ctx: { getContextUsage: () => { percent: number | null; contextWindow: number } | undefined },
	): string | undefined => {
		const usage = ctx.getContextUsage();
		return usage?.percent != null ? `ctx ${Math.round(usage.percent)}%` : undefined;
	};

	const buildRunningStatus = (
		ctx: { getContextUsage: () => { percent: number | null; contextWindow: number } | undefined },
	): string => {
		const context = getContextPercent(ctx);
		const turn = `Turn ${turnCount}`;
		return context ? `${context} · ${turn}` : turn;
	};

	const buildDoneStatus = (
		cost: number,
		ctx: { getContextUsage: () => { percent: number | null; contextWindow: number } | undefined },
	): string => {
		const context = getContextPercent(ctx);
		const formattedCost = cost > 0 ? formatCost(cost) : undefined;
		if (context && formattedCost) return `${context} · ${formattedCost}`;
		return context || formattedCost || "Done";
	};

	const cancelFinalFade = (): void => {
		if (!finalFadeTimeout) return;
		clearTimeout(finalFadeTimeout);
		finalFadeTimeout = undefined;
	};

	const scheduleFinalFade = (sequence: number): void => {
		cancelFinalFade();
		finalFadeTimeout = setTimeout(() => {
			finalFadeTimeout = undefined;
			if (sequence === runSequence && doneStatusText) {
				setStatus(undefined, "#8E8E93", doneStatusText);
			}
		}, finalFadeDelayMs);
		(finalFadeTimeout as { unref?: () => void }).unref?.();
	};

	pi.on("session_start", async () => {
		cancelFinalFade();
		turnCount = 0;
		doneStatusText = undefined;
		clearProgress();
		clearStatus();
	});

	pi.on("agent_start", async () => {
		runSequence += 1;
		cancelFinalFade();
		turnCount = 0;
		doneStatusText = undefined;
		clearProgress();
		setStatus("progress.indicator", "#0A84FF", "Turn 1");
	});

	pi.on("turn_start", async (event, ctx) => {
		turnCount = Math.max(turnCount, event.turnIndex + 1);
		setStatus("progress.indicator", "#0A84FF", buildRunningStatus(ctx));
	});

	pi.on("tool_result", async (_event, ctx) => {
		setStatus("progress.indicator", "#0A84FF", buildRunningStatus(ctx));
	});

	pi.on("agent_end", async (_event, ctx) => {
		const cost = getBranchCost(ctx.sessionManager.getBranch());
		doneStatusText = buildDoneStatus(cost, ctx);
		setStatus("checkmark.circle.fill", "#30D158", doneStatusText);
		scheduleFinalFade(runSequence);
	});

	pi.on("session_shutdown", async () => {
		runSequence += 1;
		cancelFinalFade();
		clearProgress();
		clearStatus();
		await flushCmux();
	});
}
