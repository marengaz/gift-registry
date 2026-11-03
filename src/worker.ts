import { getDatabase } from './lib/server/db/client';
import { runNextJob } from './lib/server/enrichment/jobs';
const connection = getDatabase();
let stopping = false;
process.on('SIGTERM', () => {
	stopping = true;
});
process.on('SIGINT', () => {
	stopping = true;
});
try {
	while (!stopping) {
		const worked = await runNextJob(connection);
		if (!worked) await new Promise((resolve) => setTimeout(resolve, 1000));
	}
} finally {
	connection.close();
}
