/**
 * The HH:MM (24-hour) format shared by the board-worker schedule validator and
 * the config normalizer that fills in defaults for a malformed window.
 *
 * Both had their own copy of this regex. They must agree: the validator decides
 * whether an operator's `boardWorker.schedule` value is reported as a problem,
 * and the normalizer decides whether that same value is kept or replaced by the
 * default window. A drift between them would silently accept a value at load and
 * then discard it at use, or the reverse.
 */
export const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
