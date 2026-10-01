// Optional enhancement: copy the MCP endpoint to the clipboard.
// The page works without this script; the button stays hidden then.
document.querySelectorAll("button[data-copy-target]").forEach((button) => {
  const target = document.getElementById(button.dataset.copyTarget);
  const status = document.querySelector(".status");
  if (!target || !navigator.clipboard) return;

  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      if (status) status.textContent = "Endpoint copied.";
    } catch {
      if (status) status.textContent = "Copy failed; select the address and copy it manually.";
    }
  });
});
