// Generated output has to come out identical on every run and every platform,
// or a document bump produces a diff nobody can review. Every list the
// generator writes is ordered through here.

/**
 * Compares by UTF-16 code unit, which is what `Array.sort` does by default and
 * what `localeCompare` does not: locale-aware ordering would put the same
 * document in different orders on different machines.
 */
export function compare(left: string, right: string): number {
	if (left === right) {
		return 0;
	}

	return left < right ? -1 : 1;
}

/** `Object.entries`, ordered by key. */
export function byKey<T>(entries: Readonly<Record<string, T>>): [string, T][] {
	return Object.entries(entries).sort(([left], [right]) => compare(left, right));
}
