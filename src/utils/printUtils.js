export function openPrintDialogForElement(element, title = "Print", printWindow = null) {
  if (!element) {
    throw new Error("Nothing is available to print yet.");
  }

  const targetWindow = printWindow || window.open("", "_blank");
  if (!targetWindow) {
    throw new Error("Browser blocked the print window.");
  }

  const styles = Array.from(
    document.querySelectorAll('link[rel="stylesheet"], style')
  )
    .map((node) => {
      if (node.tagName.toLowerCase() === "link") {
        return `<link rel="stylesheet" href="${node.href}">`;
      }

      return node.outerHTML;
    })
    .join("\n");

  targetWindow.document.open();
  targetWindow.document.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <base href="${window.location.origin}/">
    <title>${title}</title>
    ${styles}
    <style>
      @page { size: letter; margin: 0.25in; }
      html, body {
        margin: 0;
        min-height: 100%;
        background: #ffffff;
      }
      body {
        display: flex;
        justify-content: center;
        align-items: flex-start;
      }
      * {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
    </style>
  </head>
  <body>
    ${element.outerHTML}
    <script>
      window.addEventListener("load", () => {
        setTimeout(() => {
          window.focus();
          window.print();
        }, 120);
      });
    </script>
  </body>
</html>`);
  targetWindow.document.close();

  return targetWindow;
}
