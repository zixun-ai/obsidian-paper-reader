/** Serialize plugin transactions, including creation and write verification, per vault/path. */
const queues = new WeakMap<object, Map<string, Promise<unknown>>>();

export async function withFileLock<T>(owner: object, path: string, action: () => Promise<T>): Promise<T> {
	let paths = queues.get(owner);
	if (!paths) queues.set(owner, paths = new Map());
	const task = (paths.get(path) ?? Promise.resolve()).catch(() => {}).then(action);
	paths.set(path, task);
	try { return await task; }
	finally { if (paths.get(path) === task) paths.delete(path); }
}
