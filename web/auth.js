// Clerk Core 3 ships its UI separately from the session SDK.
export async function loadClerk(publishableKey) {
  const domain = atob(publishableKey.split("_")[2]).slice(0, -1);
  if (!/^[a-z0-9.-]+$/i.test(domain))
    throw new Error("Invalid Clerk frontend domain");
  const [{ Clerk }] = await Promise.all([
    import("@clerk/clerk-js"),
    new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`;
      script.async = true;
      script.crossOrigin = "anonymous";
      const timeout = setTimeout(
        () => reject(new Error("Authentication timed out")),
        15000,
      );
      script.onload = () => {
        clearTimeout(timeout);
        resolve();
      };
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Authentication UI unavailable"));
      };
      document.head.appendChild(script);
    }),
  ]);
  const clerk = new Clerk(publishableKey);
  await clerk.load({
    ui: { ClerkUI: window.__internal_ClerkUICtor },
    appearance: {
      variables: {
        colorPrimary: "#8c784b",
        colorBackground: "#14252a",
        colorText: "#eee8d8",
        colorTextSecondary: "#b9c7c0",
        colorInputBackground: "#0d1a20",
        colorInputText: "#eee8d8",
        borderRadius: "4px",
      },
    },
  });
  return clerk;
}
