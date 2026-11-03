import { error, redirect } from '@sveltejs/kit';
export async function pageResult(response: Response | Promise<Response>) {
	const result = await response;
	const data = await result.json();
	if (result.status === 401) redirect(303, '/login');
	if (!result.ok) error(result.status, data.message);
	return data;
}
