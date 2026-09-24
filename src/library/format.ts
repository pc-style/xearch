/** A search-service timing, reported in microseconds, as milliseconds. */
export const formatDuration = (microseconds: number) => `${(microseconds / 1000).toFixed(2)} ms`;
