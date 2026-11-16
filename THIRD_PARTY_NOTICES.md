# Third-party artwork

## Red panda pet

- Artist: Elthen / Elthen's Pixel Art Shop
- Asset: [2D Pixel Art Red Panda Sprites](https://elthen.itch.io/2d-pixel-art-red-panda-sprites)
- Terms: [Elthen's Common Sense License 1.0](https://www.patreon.com/elthen/posts/licensing-27430241), checked 20 October 2026

The license permits use in personal and commercial projects and modification to fit those projects. Credit is optional. It prohibits standalone resale or redistribution of the assets, use in blockchain or cryptocurrency projects, and use for training AI systems.

Pagebot embeds only the animation frames used by its pet, as part of the widget. The original standalone sprite pack is not included. The artwork remains Elthen's; these project files do not grant a separate right to extract or redistribute it.

## Cat and fox companions

- Artist: Elthen / Elthen's Pixel Art Shop
- Assets: [2D Pixel Art Cat Sprites](https://elthen.itch.io/2d-pixel-art-cat-sprites) and [2D Pixel Art Fox Sprites](https://elthen.itch.io/2d-pixel-art-fox-sprites)
- Terms: [Elthen's Common Sense License 1.0](https://www.patreon.com/elthen/posts/licensing-27430241), checked 16 November 2026

Personal and commercial project use and modification are permitted. Asset redistribution and resale are restricted; blockchain/cryptocurrency uses and training AI systems are prohibited. Credit is optional. Pagebot includes only the animation frames used by its companion feature as embedded application data, not the original standalone packs. The artwork and its separate reuse rights remain Elthen's.

Original downloaded files, before extracting frames:

| File | SHA-256 |
| --- | --- |
| `Cat Sprite Sheet.png` | `28723e8039cde4218da26ff51cbbaca05052ab7c27ca2eb896cf4bb11392fd29` |
| `Fox Sprite Sheet.png` | `819a2790d2fa4866216d49babffabf0d24a0258addeaa3b671ecbede91bf2b0d` |

The original cells are 32 × 32 pixels. Pagebot crops a common transparent 26 × 26 window beginning at `(3, 9)` in each cell and displays it at integer 3× scale (2× in the selector). It uses 45 cat frames across idle, looking, grooming, movement, sleep, paw, jump, and scared sequences; the fox uses 49 frames across idle, looking, movement, catch, flinch, and sleep. Death sequences and the full source sheets are not embedded. The artist's visible pixels and palette are preserved.

## Frog companion

- Artist: Eduardo Scarpato
- Asset: [Toxic Frog Animations Pixel Art 2D FREE](https://eduardscarpato.itch.io/toxic-frog-animations-pixel-art-2d-free), GreenBrown variation
- Terms: the **License** section of the linked asset page, checked 16 November 2026

The author's terms permit use in free and commercial projects, prohibit direct sale or distribution of the assets, including modified versions, and make credit optional. Pagebot embeds the used frames as part of its companion feature; the downloadable ZIP, Aseprite project, other colour variations, and unused attack/explosion animations are not included. The artwork remains Eduardo Scarpato's and does not acquire a separate extraction or redistribution license through this repository.

Original files inside `ToxicFrog.zip`, before extracting frames:

| File | SHA-256 |
| --- | --- |
| `GreenBrown/ToxicFrogGreenBrown_Idle.png` | `fb47efa257eb888e36c3a82275870d79991c46061b22e4d297e13ded2136a8ae` |
| `GreenBrown/ToxicFrogGreenBrown_Hop.png` | `95c12730e8ba0d4fc36c523e82c9630828a942d0ac33500f0eea0f1548c35a17` |
| `GreenBrown/ToxicFrogGreenBrown_Hurt.png` | `27862616afdf7d10502acb338e7ed57b093ec15bd57710dacd8bd6d5d80ad7f7` |

The original cells are 48 × 48 pixels. Pagebot uses the eight idle, seven hop, and four hurt frames, cropping a common transparent 26 × 26 window beginning at `(8, 9)` in each source cell. The visible frog pixels remain unchanged and display at integer scales with nearest-neighbour rendering. The source does not contain a sleep animation: the app holds an authored quiet/blinking idle pose when the frog rests or the panel locks.
