# Brand fonts for server-side rendering

The static TrueType files sharp draws text with (MockProvider placeholders now, the Adapter's
overlays in Phase 5). sharp renders text through Pango/fontconfig, which needs a real TTF/OTF file
(`sharp({ text: { fontfile } })`); the web app's `@fontsource-variable` woff2 files don't load
there, so these are committed instead.

| File                        | Family (Pango `font`) | Weight | Version | Licence                 |
| --------------------------- | --------------------- | ------ | ------- | ----------------------- |
| `SpaceGrotesk-Bold.ttf`     | `Space Grotesk Bold`  | 700    | 2.000   | `SpaceGrotesk-OFL.txt`  |
| `Inter-SemiBold.ttf`        | `Inter SemiBold`      | 600    | 4.001   | `Inter-OFL.txt`         |
| `JetBrainsMono-Regular.ttf` | `JetBrains Mono`      | 400    | 2.211   | `JetBrainsMono-OFL.txt` |

All three are licensed under the SIL Open Font License 1.1; each licence file is the upstream
project's `OFL.txt` (copyright line plus the full licence text). The fonts are unmodified.

## Provenance

The files are Google Fonts' static instances, as redistributed on npm by the
`@expo-google-fonts/*` packages (package licence `MIT AND OFL-1.1`; the fonts themselves are OFL):

| File                        | npm package                               | Path in the package                       | Google Fonts source                     |
| --------------------------- | ----------------------------------------- | ----------------------------------------- | --------------------------------------- |
| `SpaceGrotesk-Bold.ttf`     | `@expo-google-fonts/space-grotesk@0.4.1`  | `700Bold/SpaceGrotesk_700Bold.ttf`        | `fonts.gstatic.com/s/spacegrotesk/v22`  |
| `Inter-SemiBold.ttf`        | `@expo-google-fonts/inter@0.4.2`          | `600SemiBold/Inter_600SemiBold.ttf`       | `fonts.gstatic.com/s/inter/v20`         |
| `JetBrainsMono-Regular.ttf` | `@expo-google-fonts/jetbrains-mono@0.4.1` | `400Regular/JetBrainsMono_400Regular.ttf` | `fonts.gstatic.com/s/jetbrainsmono/v24` |

The licence files are the same packages' `LICENSE_FONT` files (Space Grotesk's converted from CRLF
to LF line endings). Upstream projects: [Space Grotesk](https://github.com/floriankarsten/space-grotesk),
[Inter](https://github.com/rsms/inter), [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono).

SHA-256:

```
8fb63865c6afd083723dc1775548306b7751f20397bebcb79646032c598c81b9  SpaceGrotesk-Bold.ttf
f30e9d2574c3bec5144347ff965f9841c8f06857f0b7383000f8c9489a161841  Inter-SemiBold.ttf
b6b1ff4ddefe36d7f2a6174e1d001cab374e594519ee9049af028d577b64c5f5  JetBrainsMono-Regular.ttf
```

## Using them

Resolve paths with `brandFontFile()` from `src/imaging/fonts.ts` (it works from TypeScript source
and from the API's tsup bundle alike), and always pass `fontfile` together with the family in
`font`:

```ts
sharp({
  text: {
    text: '<span foreground="#F5F5F4">Iftar, iced.</span>',
    font: "Space Grotesk Bold 64", // family + style from the table above, then the size
    fontfile: brandFontFile("SPACE_GROTESK"),
    rgba: true,
    dpi: 72,
    width: 960,
    wrap: "word",
  },
});
```
