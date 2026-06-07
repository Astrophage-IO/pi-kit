import type { MissionStatus } from "./mission.ts";

export interface AutoTickGate {
	status: MissionStatus;
	loopArmed: boolean;
	paused: boolean;
	stopRequested: boolean;
	idle: boolean;
	hasPending: boolean;
}

/**
 * Authoritative gate for the self-driving loop: may the agent re-trigger another turn now? Re-checked
 * at fire time (not just when scheduling) so a cross-process pause/stop landing during the tick delay
 * cannot leak an extra turn.
 */
export function canAutoTick(gate: AutoTickGate): boolean {
	return (
		gate.loopArmed &&
		gate.status === "running" &&
		!gate.paused &&
		!gate.stopRequested &&
		gate.idle &&
		!gate.hasPending
	);
}

/** Count of consecutive turns that recorded no new experiment; resets to 0 once progress is made. */
export function nextEmptyTicks(prevEmptyTicks: number, lastSeenIteration: number, iteration: number): number {
	return iteration <= lastSeenIteration ? prevEmptyTicks + 1 : 0;
}

/** Disarm the loop after too many turns with no recorded experiment (prevents a spinning, token-burning loop). */
export function shouldDisarm(emptyTicks: number, maxEmptyTicks: number): boolean {
	return emptyTicks >= maxEmptyTicks;
}
