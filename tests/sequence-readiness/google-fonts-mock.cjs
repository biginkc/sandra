/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");

// Next's Google font loader supports a response map specifically for offline
// tests. The response only contains CSS; the font bytes are read from the
// bundled Next devtools fixture below, so the browser lane never contacts
// fonts.googleapis.com or fonts.gstatic.com.
const interFont = path.resolve(
  __dirname,
  "../../node_modules/next/dist/next-devtools/server/font/geist-latin.woff2",
);
const monoFont = path.resolve(
  __dirname,
  "../../node_modules/next/dist/next-devtools/server/font/geist-mono-latin.woff2",
);

const fontCss = (family, file) => `/* latin */
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(${file}) format('woff2');
}
`;

module.exports = {
  "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap":
    fontCss("Inter", interFont),
  "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&display=swap":
    fontCss("Geist Mono", monoFont),
};
