export function openAuthorizedPopup(): Window | null {
  const popup = window.open("about:blank", "_blank");
  if (!popup) return null;
  try {
    popup.opener = null;
    const referrerPolicy = popup.document.createElement("meta");
    referrerPolicy.name = "referrer";
    referrerPolicy.content = "no-referrer";
    popup.document.head.append(referrerPolicy);
    return popup;
  } catch {
    closeAuthorizedPopup(popup);
    return null;
  }
}

export function navigateAuthorizedPopup(popup: Window, url: string): boolean {
  try {
    if (popup.closed) {
      closeAuthorizedPopup(popup);
      return false;
    }
    popup.location.replace(url);
    return true;
  } catch {
    closeAuthorizedPopup(popup);
    return false;
  }
}

function closeAuthorizedPopup(popup: Window): void {
  try {
    popup.close();
  } catch {
    // The placeholder is already inaccessible; there is nothing else to close.
  }
}
