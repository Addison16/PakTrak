# Accounts and lifetime scan limits

Open **Menu → My account** to see your membership, lifetime card usage, remaining allowance, collection/deck/batch counts and active sign-in sessions. You can change your display name, open the password-change screen, sign out other devices and choose Auto, Light or Dark appearance. The display name does not change your sign-in username. Profile changes survive later logins.

Personal password changes use the existing identity provider's secure screen and require fresh authentication; PakTrak does not receive the password you choose. Passwords still require at least eight characters. The return flow is bound to the original account. This uses Keycloak's documented [application-initiated actions](https://www.keycloak.org/docs/latest/server_admin/#_application_initiated_actions). Sign out other devices separately when you want to revoke existing PakTrak sessions.

## Administrator controls

Open **Menu → Administration → User management**. The list starts with all accounts, supports name search, offers a guests-only view, and paginates in groups of 50. Choose **Manage account** to open someone's settings; **Back to users** returns to the list. Server-wide guest signup, scan processing, data updates and error logs appear on the main Administration page and are hidden while an individual account is open. Changes require **Save account settings**, and unsaved edits warn before leaving. A concurrent change requires an explicit reload before saving again.

- **Approve as standard member** removes the guest allowance and any guest-specific cap, giving unlimited scanning by default. It preserves the lifetime usage count. Repeating approval on an existing member does not remove a custom limit. The congratulations message on their next verified login reflects their current allowance.
- **Pause new scans** blocks new uploads, finalization of unaccepted uploads, new manual card outlines and requests to find additional cards. Collection browsing, decks, CSV/text imports and corrections/approval of existing scan cards remain available. Scans already accepted by the server finish independently of the phone, subject to the current lifetime card limit.
- **Set a lifetime card limit** caps the total number of cards scanned for that account. For example, a person with 75 scans used and a limit of 200 has 125 left. You can clear the number field, enter zero, lower or raise the limit, or restore **Unlimited card scans** for a member. Limits do not reset each month. A guest's default remains 100; approve the guest to make them an unlimited member.
- **Sign out all devices** revokes that person's PakTrak sessions. They may sign in again, potentially through an existing identity-provider session. Use suspension to block further access.
- **Reset password** creates a temporary sign-in password, ends the user's PakTrak and identity-provider sessions, and requires a new password at the next sign-in. Copy the temporary password and share it privately with the displayed sign-in username. This does not change the user's role, scan allowance or saved collection.
- **Account access → Suspended** signs the user out and blocks new application sign-ins. Their cards, decks and batch records are preserved. Choose **Active** and save to let them sign in again; previously revoked sessions stay invalid. Suspension requires confirmation.

Administrator accounts are protected from the per-user access, quota, password-reset and sign-out controls, including attempts made directly against the API. Administrators can manage their own profile, password and other sessions through **My account**. New account registration remains controlled independently by **Allow guest signup**.

## Resetting a user's password

1. Open **Administration → User management → Manage account** for the guest or member. Save or discard any account-setting edits first.
2. Choose **Reset password** and confirm the named account. The reset ends their current sign-ins immediately.
3. Use **Copy password**, or **Show password** to copy manually. Send the displayed sign-in username and temporary password privately to that person, then choose **I've saved the password**. PakTrak does not send an email or message for you.
4. The user signs in with the temporary password and chooses a new password of at least eight characters before entering PakTrak. A suspended account must also have its access restored.

The temporary password is returned once with cache prevention and kept only in the current page's memory, initially hidden. It is not saved in browser storage, account activity or app error logs. Closing the account clears it; leaving before acknowledging it prompts a warning. An administrator cannot retrieve it later. If it was lost, reload the account and reset again to create a new one.

A failed reset never displays an unconfirmed password. If the provider cannot be reached before the reset starts, the existing password and app sessions remain unchanged. If the operation fails after it starts, app sessions have already ended and the outcome is explained on screen; reload and explicitly retry. A process interruption leaves a pending reset that blocks application sign-in until an administrator retries. Concurrent resets and stale account versions cannot silently overwrite each other.

## What counts

The allowance counts individual new card regions accepted from photographs, including manually outlined cards. A photo containing 15 new cards uses 15 scans, not one. Processing retries, rechecking existing cards and correcting an existing outline do not charge again. CSV/text collection imports and deck lists do not count. Deleting cards or batches does not refund lifetime usage.

Limits are checked on the server, with a per-user database lock shared by uploads, manual additions and workers. Policy changes during an upload are checked again before its object is attached to a scan. Concurrent workers cannot both spend the same remaining allowance. If the newly detected cards in a processing attempt exceed the remaining allowance, that attempt fails without adding or charging those new regions. Raising a cap or restoring unlimited scanning keeps the usage history intact. Processing concurrency remains separate from the lifetime allowance.

The account screen refreshes usage and pause status with the normal session refresh. An already-open device shows a sign-in recovery message after session revocation; saved data is preserved. Passwords, provider subjects and session tokens are not included in account summaries. Profile, approval, policy and session changes have private audit records; the owner and administrators can view the ten most recent events.

## Upgrade

Migration `ab42d9e71c60` adds optional profile names, suspension/pause flags, a nullable limit override, a settings version and account audit records. Existing accounts keep their roles and lifetime counts. They start active and unpaused, with the existing default allowance: guests 100, members and administrators unlimited. Global signup/enhancement settings and all collection data are preserved.

Migration `c72d10a4e691` adds password-reset timestamps and an in-progress flag. Existing users start with no reset pending; their credentials and current settings are preserved. Normal startup adds the dedicated password-management credential to older `.env` files and provisions its identity service client. See [operation and upgrade details](OPERATIONS.md#personal-accounts-and-user-management).

Back up PostgreSQL, including identity state, and `.env` before upgrading. The normal Docker startup applies migrations before replacing the API and workers. Do not downgrade a live installation without a coordinated backup and matching application version: removing these columns would discard access restrictions, custom limits and password-reset protection.
