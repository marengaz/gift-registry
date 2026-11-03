import { defineConfig } from 'vite';
export default defineConfig({
	ssr: { noExternal: ['@sveltejs/kit'] },
	build: {
		ssr: 'src/worker.ts',
		outDir: 'build-worker',
		emptyOutDir: true,
		target: 'node26',
		rolldownOptions: { output: { entryFileNames: 'worker.js' } }
	}
});
