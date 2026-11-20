# Reference Studio

One screen, `/projects/<project>/studio`, that turns a limited or imperfect reference photograph into the consistent set
of references a film needs, and lets the creator change an image, compare takes and promote the one they choose.

It is the front door to the **existing** Character / Location image pipeline (Phase 5B-I1 … I5,
[phase-5b-image-pipeline](phase-5b-image-pipeline.md)). It adds no second pipeline, no table and **no migration**.

**Status.** Implemented and browser-tested on the free test models. **Not yet creatively accepted:** the test models
draw a placeholder pattern, so nothing here proves how a real picture looks. That needs the bounded real-provider test
in [First real test](#first-real-test), which spends money and therefore needs the owner's authorization.

## What the owner can do

| Step           | In the Studio                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pick a subject | Every Character and Location of the project, each with the picture that currently stands for it.                                                                                     |
| Add photos     | Drop them on the Studio or choose files: JPEG, PNG or WebP, several at once. Each is listed with what will be sent before anything is uploaded. See [Adding photos](#adding-photos). |
| See what it is | Size, format, whether it is an uploaded original or a generated picture, what the Visual Bible uses it as, where the project uses it. See [Inspection](#inspection).                 |
| Make           | Front portrait, 3/4 view, left profile, right profile, half body, full body, wardrobe reference, look sheet, expression, scene variation; seven Location views.                      |
| Change         | Hair colour, clothing (typed, or one of the Character's Looks), lighting and quality, clean studio background, replace background, remove people, or the creator's own change.       |
| Cut out        | Prism's own free background removal (original pixels, plain backgrounds). A busy background is refused; the paid tool is offered only where it is configured.                        |
| See the price  | Before anything is made: the server's upper bound in dollars, and what images like it were really billed in this project. See [Money](#money).                                       |
| Judge          | The starting image beside the result on a neutral surround; two to four takes side by side with what they started from.                                                              |
| Reject         | With a reason. The take stays in history, is never deleted or remade on its own, and is no longer offered as a starting image. Restore undoes it.                                    |
| Promote        | Canonical identity, an identity slot, a Look, the cutout; canonical Location, a Location reference, a named Location View. Each is an explicit act.                                  |
| Go on          | Links to the Shots the subject appears in, where the existing Production Frame generator sends these references on its own.                                                          |

Nothing is overwritten. A generated or changed picture is a new immutable Asset with its attempt's provenance; a
promotion only points a Visual Bible slot at it; replacing a slot or a canonical image that already holds a picture needs
an explicit confirmation, and the replaced picture stays in the library.

## Adding photos

The upload area is always on the screen, in the brief under the subject's pictures (large while the subject has no
picture yet), and the empty stage has a "Choose photos" button. Files dropped anywhere on the Studio go to it.

1. **Chosen or dropped files are read in the browser first.** Nothing is sent yet. Each photo is listed with a picture
   of what will be sent, its size and format, and the same size verdict the Studio gives a stored image.
2. **A file that is not a JPEG, PNG or WebP picture, or will not open, is refused in the list** with the reason (HEIC is
   named as the iPhone format, with what to do). It never leaves the browser.
3. **The creator says what the photos show**: references of the subject (any number), one empty identity slot (front,
   3/4, profile, full body: one photo), or a Look's wardrobe reference. A Location takes references.
4. **Upload** sends the photos one request each, in order. A failure stays in the list with the server's reason; the
   others are not affected. The first photo added as a reference of the subject becomes the starting image.

A chosen file is stored byte for byte whenever it can be. Two things prevent that, and in both a **copy made in the
browser** is sent instead and is said to be a copy, in the list before uploading and on the stored image afterwards:

| Why                                | What is sent                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| More than one upload can carry     | A copy 2048 px on its long side (1536 px if that is still too large), shape kept.                         |
| The camera stored the photo turned | An upright copy at the picture's own size (at most 4096 px on the long side), with no rotation flag left. |

A JPEG stays a JPEG; a PNG or WebP is written as WebP, which keeps transparency. Resolution is given up last: at the
first size a JPEG is tried once more, a little more compressed, before the copy is made smaller. An upright copy that
still does not fit one upload at full size is made smaller, and is then recorded as both.

- "One upload can carry" is the host's limit, not Prism's: `singleUploadLimit` gives 4 MB on Vercel (see
  [Deployment](#deployment)), Prism's own 25 MB elsewhere, or what the operator states in
  `PRISM_STUDIO_MAX_UPLOAD_BYTES`.
- A phone usually stores a portrait photograph on its side with an EXIF rotation flag. A viewer honours the flag; a tool
  that ignores it sees the picture sideways, and Prism's own stored width and height would describe it sideways. So the
  copy has the rotation in its pixels.
- The copy is stored with the record of the file that was chosen (name, size, dimensions, and why a copy was made) in
  `metadata.uploadCopy`, the tag `browser-copy` and a sentence in the Asset's notes. That record is the browser's word
  and decides nothing on the server. The Studio labels such an image "uploaded copy", never "uploaded original", and
  the chosen file itself was never uploaded, so Prism never claims to hold it.
- If a browser cannot make the copy, a turned photo is added as it is (and stays flagged, below); a photo that is too
  large is refused with what to do.

**Any other upload form** (the Character page's identity slots, a Look's references) stores the file as it arrives. The
shared upload step now records a JPEG's rotation flag (`metadata.exifOrientation`) without changing a byte, and the
Studio then describes that picture the way it is displayed and says it is stored turned. Adding the photo again in the
Studio uploads an upright copy.

Code: `src/domain/generation/reference-upload.ts` (the decision, pure), `src/components/studio/photo-upload.tsx` (the
queue and the copy), `src/lib/image-size.ts` (`readJpegOrientation`), `src/lib/upload-policy.ts`
(`singleUploadLimit`), `src/server/reference-studio-actions.ts` (`uploadReferencePhoto`).

## What is sent (prompt policy `subject-image` v2)

Version 1 described the subject in words and attached whatever references existed without saying what they were for. It
also sent the project's scene-lighting style, story canon and software guardrails with every reference ("Never move a
vehicle door to the wrong side" went out with a face reference), gave an edit the composition of an unrelated portrait,
and prefixed every request that carried an image with "Edit reference image 1; keep everything not described as changed"
— which asks a model to keep the reference's pose when the creator asked for a new angle.

Version 2 says what the images are **for**, and sends only what describes the picture:

| Operation   | When                                              | What the model is told                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`      | no image is sent                                  | The written description is all there is.                                                                                                                                                                                                      |
| `reference` | images are sent to be reproduced in a new picture | "The same person as in the identity reference image: keep the face, facial features, skin tone, hair, apparent age and build exactly as shown." The reference wins over the written notes. Pose, framing and background come from the preset. |
| `edit`      | one image is changed                              | "Change only this in the image being edited: …" and "Keep everything else exactly as it is". No composition, no written appearance, no other image.                                                                                           |

- **What is chosen is what is sent.** The Studio states its choice of starting images. One photo selected sends that
  photo, not also a generated canonical image the creator did not pick. Nothing selected ("Words only") sends no
  identity image. A selected Look brings its own wardrobe images and words; its hair styling replaces the reference's.
- **Left and right are screen directions**, so the two profiles are unambiguous.
- **A studio reference is neutral**: plain light-grey background, even light. The project's visual style is sent in full
  only where the picture is the film's world (a Location, a scene variation).
- **A generated picture is named as generated** in the request ("Yumeko generated reference"), never as a photograph.
- The older panels (Character page, Location cards) state no choice, so their automatic selection is unchanged
  (canonical identity → the Look → the other references). They get the same v2 wording.

The policy, the operation, the chosen images and the creator's own inputs are frozen on the attempt
(`modelSettings.promptPolicy`, `.operation`, `.sourceAssetIds`, `.composer`; the package snapshot is
`prism.subject-image-package.v2`). Attempts frozen earlier are untouched.

**OpenAI adapter.** OpenAI's edit endpoint is the one that accepts input images, so it also serves "make a new picture
of the person in these references". The request now states its operation
(`providerOptions.prismImageOperation`), and for `reference` the first line is "Create a new image. The reference images
show who or what must be reproduced faithfully; take the pose, framing and background from the description below, not
from the references." A request with no stated operation (every Production Frame request, and everything frozen before)
keeps the original line exactly.

Code: `src/domain/generation/subject-image.ts` (the plan), `src/generation/subject-submission.ts` (the request),
`src/generation/providers/openai-image/adapter.ts` (the first line).

## Money

- **Before.** `quoteReferenceImage` runs the same preparation as the submission and returns the server's estimate, the
  images that will be sent and the text the provider receives. It is a read: nothing is queued, stored or sent, and no
  worker is started.
- **Confirmation.** A paid Character / Location image is started only with a confirmed dollar amount that covers the
  server's estimate (`paidConfirmationRefusal`). The Studio's Generate button carries the amount it shows ("Generate ·
  up to $0.126"). A click that showed no price is refused. The older panels' one-click presets therefore open the
  Studio when their model is paid; with a free model they work as before.
- **The estimate is an upper bound**, and for GPT Image it is provisional and generous (see
  `openai-image-catalog.ts`). On the hosted project the six finished images of 2026-11-09 were estimated at $0.079 to
  $0.224 and billed $0.0095 to $0.0411. So the Studio also shows "Images like it have cost about $X here": the median
  actual of finished images with the same model, quality and number of sent images (`typicalCost`), or says that
  nothing comparable exists. It never guesses.
- **After.** Each take shows what was billed, from the provider's reported usage. A free test model reports a pretend
  cost; it is never shown as money billed.
- The deployment's spend gate and ceilings are unchanged and still apply first.

## Inspection

`inspectReferenceImage` reports only what Prism can know from stored facts: pixel size, megapixels, orientation, format
(read from the bytes at upload), file size, transparency, and whether an image model can take the file (JPEG, PNG or
WebP, up to 25 MB; AVIF and GIF are kept as originals but cannot be sent). The verdict goes by the shorter side: below
512 px "Small image", 512 to 1023 "Usable", 1024 and up "Good size". These are guidance thresholds, not measurements of
quality, and every inspection ends with "Sharpness, lighting and expression are not measured: judge them by eye."

A photograph stored turned by its camera (see [Adding photos](#adding-photos)) is described the way it is displayed,
and flagged. A copy made in the browser at upload says what it was made from.

## Review

A Character / Location image is never "approved" (`approved` stays false, as migration 0051 requires). Acceptance is
the explicit promotion. `reviewSubjectImageAttempt` writes review fields only (`review_status`, `rejection_categories`,
`rejection_reason`, `reviewed_at`), which the append-only guard allows. A picture the project currently uses cannot be
rejected until that use ends.

## Locks

- A locked identity slot protects a reference **image**. A slot that only holds a placeholder record with no stored
  file has nothing to protect, so it can be filled; a slot that holds an image is replaced only after unlocking.
- A locked Look or Location refuses new references, as before. The Studio shows the lock before the click.

## Tests

- Unit: `src/domain/generation/__tests__/reference-studio.test.ts`, `subject-image-policy.test.ts`,
  `reference-upload.test.ts`; `src/lib/__tests__/image-orientation.test.ts`, `upload-policy.test.ts`;
  `src/generation/__tests__/reference-studio-flow.test.ts` (GPT Image on the fake transport: the exact images and prompt
  the transport is handed); `src/server/__tests__/reference-studio.test.ts` (quote, confirmation, upload, review, read
  model).
- Browser: `e2e/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-reference-studio.spec.ts`, stories A to M, on its own memory server
  with the free test models. GPT Image is listed there as a paid worker-backed model with an empty key so its price can
  be shown; no story starts a paid image. Stories L and M cover the upload area in a real browser: several photos chosen
  and dropped, a file that is not a picture, a photo too large for one upload (the server states a 1 MB limit), and a
  photo stored turned, whose uploaded copy is checked pixel by pixel to be upright.

## Deployment

- No migration. No new provider. One optional environment variable, `PRISM_STUDIO_MAX_UPLOAD_BYTES` (leave it unset
  on Vercel).
- The web app must be deployed for the screen to exist. The **generation worker** compiles the provider prompt, so the
  corrected first line reaches OpenAI only after the workers project is redeployed from this code. With the old worker a
  `reference` request still runs, with the old first line in front of the new body.
- Background removal for a busy background needs the paid cutout provider's key, which neither hosted project has.
- **Upload size on Vercel.** Every upload in Prism travels in a server action, and Vercel caps a function's request
  body at 4.5 MB whatever `serverActions.bodySizeLimit` says (that setting only applies off Vercel). The Studio
  therefore sends at most 4 MB per photo there: a larger photo is added as a smaller copy made in the browser (see
  [Adding photos](#adding-photos)), so a phone photograph can be added on the hosted site today. The full-size file is
  not stored in that case. The same platform limit applies to every other upload in the app (identity slots, Production
  Frames, performance audio, previs clips), which do not yet check it. Storing full-size originals on Vercel means
  uploading straight from the browser to Storage: not built.

## First real test

Not run. It needs the owner's authorization, because it spends money.

| Item        | Proposal                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Input       | One real photograph of the person who is Yumeko, uploaded by the owner. (The hosted project has no uploaded photo of any Character.) |
| Images      | Front portrait, 3/4 view, left profile, right profile, half body, full body: six images, each from that one photo.                   |
| Model       | GPT Image 2.5 Flare, standard quality, portrait 2:3.                                                                                 |
| Upper bound | About $0.13 each, about $0.76 for six. Each is under the workers' current $0.50 ceiling.                                             |
| Expected    | About $0.02 to $0.03 each going by the one comparable hosted image ($0.0243 with one starting image), so about $0.15 in all.         |
| Pass        | The owner looks at the six beside the photo and says whether it is the same person. Nothing is retried automatically.                |
| Needs       | This branch deployed to the review site, and the workers project redeployed from it.                                                 |
