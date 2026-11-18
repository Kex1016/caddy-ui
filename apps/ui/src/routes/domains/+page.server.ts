import type { ApiError } from '$lib/api/porkbun';
import { toListRow, type AccountInfo, type DomainList, type ListRow } from '$lib/porkbun/domains';
import { loadAccount, loadDomainList } from '$lib/porkbun/domains/data.server';
import { isConfigured, toApiError } from '$lib/server/porkbun';
import type { PageServerLoad } from './$types';

/**
 * The domain list and the account figures. With the keys unset the layout shows the set-up instead and this
 * makes no call. A list that can not be read (Porkbun down and nothing cached) is handed to the page as
 * `listError`, not thrown, so the page can say why.
 */
export const load: PageServerLoad = async (): Promise<{
	list: (Omit<DomainList, 'data'> & { data: ListRow[] }) | null;
	listError: ApiError | null;
	account: AccountInfo | null;
	now: number;
}> => {
	const now = Date.now();
	if (!isConfigured()) return { list: null, listError: null, account: null, now };
	const [list, account] = await Promise.all([
		loadDomainList().then(
			(value) => ({ value: { ...value, data: value.data.map(toListRow) }, error: null }),
			(err: unknown) => {
				const error = toApiError(err);
				if (!error) throw err;
				return { value: null, error };
			}
		),
		loadAccount()
	]);
	return { list: list.value, listError: list.error, account, now };
};
