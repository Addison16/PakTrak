# Browser navigation

PakTrak records the screens you open in browser history. Use your phone browser's normal Back gesture, its Back/Forward buttons, or the equivalent desktop controls to retrace your steps.

- Opening the main menu adds a step; Back closes it first. Choosing a destination replaces that menu step, so the next Back returns to the previous screen.
- Decks have separate history steps for the saved list, a deck overview, editing, importing, photo-deck building and card previews. Previous/Next inside a card preview changes that preview without adding a step for every card.
- Batches have list, overview and editing steps. Returning to an overview does not undo approvals, finish selections or other changes already saved on the server.
- User management remembers the account you open. My account and the other main sections participate in the same history.
- Back closes collection card details and the camera. Collection search, sorting and filters stay in memory when visiting another section in the same tab, and returning restores the scroll position.

Unfinished deck edits, deck import text, photo-deck previews, batch edits, account edits and unuploaded camera photos keep their existing discard warnings. Cancelling Back leaves the current screen and draft intact. Active uploads and saves must finish before leaving. Returning through history never resubmits a save, import, reset or upload.

An administrator's temporary password remains only on its current account screen. Leaving requires acknowledgment or confirmation; returning with Forward does not reveal it again. Browser-history entries contain screen names, record identifiers and scroll positions, never passwords, session tokens, full account records or draft contents.

Refreshing a saved deck, batch or user-account address reopens that record using an authenticated read. Deleted or inaccessible records show the normal error and a way back to their list. Collection filters are not persisted in these addresses: if a card is no longer in the current collection view after a reload, the gallery explains that it needs to be found again. Photos, unsaved edits and import text are not restored by refreshing.

This uses the established [History API](https://developer.mozilla.org/en-US/docs/Web/API/History_API/Working_with_the_History_API). Scrollable menus and dialogs contain vertical scrolling while leaving horizontal browser navigation available; horizontal `contain` would [disable native swipe navigation](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overscroll-behavior-x). PakTrak adds no touch recognizer or gesture animation. The browser controls which native gestures are available. Card-outline dragging and enlarged-photo panning retain their own interactions.

Chromium/WebKit automation exercises history traversal and navigation guards. A physical phone's edge gesture and browser animation still need device verification; desktop automation does not reproduce the browser's native phone interface.
