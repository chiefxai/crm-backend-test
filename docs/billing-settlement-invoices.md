# Usage settlement and invoices (BILL-15)

Settlement consumes workspace reservation holds from the immutable payable usage
event. Event revisions are cumulative: each revision is charged by its delta
from the latest previously settled revision. Prepaid consumption is written to
the credit ledger; postpaid charges and corrections are written to the separate
postpaid journal and exposure totals. Reservation line counters and all ledger
updates commit in one organization UnitOfWork. A measured overrun can use
postpaid only when the current platform and workspace policies permit it; it
cannot borrow from the organization credit pool.

Corrections restore prepaid credits only while the original grant remains
active. Expired credit is never recreated. Postpaid corrections produce
auditable negative debt journal entries, which can be included in a later
invoice or credit note.

`createInvoiceService()` closes a billing period into an organization invoice
with workspace itemization and a due date. Late unbilled journal entries are
added to an open invoice; if the previous invoice is already paid, the new
adjustment receives its own invoice record. Credit notes are version checked,
authorized, itemized, and limited to the unpaid balance of an open or partially
paid invoice.

Approving a manually verified invoice payment now applies a partial or final
payment to the invoice, allocates it against its postpaid journal items, reduces
the persistent exposure totals, and records an idempotent invoice payment and
fulfillment. Existing subscription and top-up approval paths remain in the
payment decision service.

No new migration, route registration, provider integration, deployment, or
database migration is part of BILL-15. The existing schema supports these
operations. The application and repository services are implemented here, but
HTTP routes and provider usage hooks are not registered yet; provider hooks and
reservation recovery remain BILL-16. The invoice payment decision path accepts
the invoice service as a dependency, so composition must provide it before
invoice approvals are available to callers.
