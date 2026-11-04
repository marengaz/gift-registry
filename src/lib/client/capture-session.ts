type Resume = () => Promise<void>;
type Prepare = () => Promise<Resume>;
let prepare: Prepare | undefined;

export function registerCapturePreparation(callback: Prepare) {
	prepare = callback;
	return () => {
		if (prepare === callback) prepare = undefined;
	};
}

export async function prepareOpenCapture(): Promise<Resume> {
	return prepare ? prepare() : async () => {};
}
