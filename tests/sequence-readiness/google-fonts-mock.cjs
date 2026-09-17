/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");

// Next's Google font loader supports a response map specifically for offline
// tests. The font bytes come from the bundled Next devtools fixtures below, so
// neither lane contacts fonts.googleapis.com or fonts.gstatic.com. Turbopack
// cannot resolve an absolute filesystem URL emitted by a mocked Google CSS
// response; its internal font transform treats that URL as a remote fetch.
// Use a local() face when the caller selects Turbopack, because that bundler
// cannot resolve an absolute filesystem URL. The browser lane pins Webpack
// and sets the flag to 0, so its production build receives filesystem URLs and
// exercises the real bundled WOFF2 asset path. The fixture never contacts a
// remote font provider.
// Resolve from the project working directory because Turbopack evaluates this
// mocked module from a virtual /mock location rather than its source path.
const mockedResponsePath = process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES;
const projectRoot = mockedResponsePath
  ? path.resolve(path.dirname(mockedResponsePath), "../..")
  : process.env.INIT_CWD || process.cwd();
const nextFontRoot = path.resolve(
  projectRoot,
  "node_modules/next/dist/next-devtools/server/font",
);
const interFont = path.resolve(
  nextFontRoot,
  "geist-latin.woff2",
);
const monoFont = path.resolve(
  nextFontRoot,
  "geist-mono-latin.woff2",
);

const turbopackBuild =
  process.env.NEXT_FONT_GOOGLE_TURBOPACK_MOCKED_RESPONSES === "1";

const fontSource = (family, file) =>
  turbopackBuild ? `local('${family}')` : `url(${file}) format('woff2')`;

const fontCss = (family, file) => `/* latin */
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: ${fontSource(family, file)};
}
`;

module.exports = {
  "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap":
    fontCss("Inter", interFont),
  "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&display=swap":
    fontCss("Geist Mono", monoFont),
};
