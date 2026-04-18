(() => {
  if (!/(^|\.)youtube\.com$/i.test(location.hostname)) {
    return;
  }

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('youtube-main-world.js');
  script.async = false;
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
})();
