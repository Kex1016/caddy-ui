/** One line of a review step: what a change does, with the value before and after. */
export type ReviewChange = {
	kind: 'create' | 'edit' | 'delete';
	/** What is changing: "A www.example.com", "Nameservers", "Auto-renew for example.com". */
	title: string;
	/** Absent for a create. */
	before?: string | null;
	/** Absent for a delete. */
	after?: string | null;
	/** A consequence worth saying: "Used by the site blog.example.com". */
	note?: string;
};
