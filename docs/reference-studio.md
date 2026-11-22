# Reference Studio

One screen, `/projects/<project>/studio`, that turns a limited or imperfect reference photograph into the consistent set
of references a film needs, and lets the creator change an image, compare takes and promote the one they choose.

It is the front door to the **existing** Character / Location image pipeline (Phase 5B-I1 … I5,
[phase-5b-image-pipeline](phase-5b-image-pipeline.md)). It adds no second pipeline, no table and **no migration**.

**Status.** Implemented and browser-tested on the free test models. On the hosted review site the owner has added
photographs and made two test patterns with the test model (2026-11-20). **Not yet creatively accepted:** no real
picture has been made with it, and a test pattern proves nothing about how one looks. That needs the bounded
real-provider test in [First real test](#first-real-test), which spends money and therefore needs the owner's
authorization.

## What the owner can do

| Step           | In the Studio                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pick a subject | Every Character and Location of the project, each with the picture that currently stands for it.                                                                                             |
| Add photos     | Drop them on the Studio or choose files: JPEG, PNG or WebP, several at once. Each is listed with what will be sent before anything is uploaded. See [Adding photos](#adding-photos).         |
| Start from     | Any number of the subject's pictures at once: every photo the creator added is selected to begin with, and all selected pictures are sent together. See [Starting images](#starting-images). |
| See what it is | Size, format, whether it is an uploaded original or a generated picture, what the Visual Bible uses it as, where the project uses it. See [Inspection](#inspection).                         |
| Make           | Front portrait, 3/4 view, left profile, right profile, half body, full body, wardrobe reference, look sheet, expression, scene variation; seven Location views.                              |
| Change         | Hair colour, clothing (typed, or one of the Character's Looks), lighting and quality, clean studio background, replace background, remove people, or the creator's own change.               |
| Cut out        | Prism's own free background removal (original pixels, plain backgrounds). A busy background is refused; the paid tool is offered only where it is configured.                                |
| See the price  | Before anything is made: the server's upper bound in dollars, and what images like it were really billed in this project. See [Money](#money).                                               |
| Judge          | A take beside what it was made from, on a neutral surround; two to four takes side by side with what they started from.                                                                      |
| Reject         | With a reason. The take stays in history, is never deleted or remade on its own, and is no longer offered as a starting image. Restore undoes it.                                            |
| Promote        | Canonical identity, an identity slot, a Look, the cutout; canonical Location, a Location reference, a named Location View. Each is an explicit act.                                          |
| Go on          | Links to the Shots the subject appears in, where the existing Production Frame generator sends these references on its own.                                                                  |

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
   others are not affected. **Every** photo added as a reference of the subject becomes a starting image (see
   [Starting images](#starting-images)).

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

## Starting images

"Make a reference" starts from **every selected picture**, sent together in one request as views of the same person or
place. Several photographs describe a person better than one, so that is the default, and the screen says so wherever
the choice shows.

- **What is selected to begin with** (`defaultStartingImages`): all of the creator's own photographs of the subject. A
  Look's wardrobe photo is not one of them (it shows what is worn, not who the Character is). Only when the creator has
  added no photograph is the picture that currently stands for the subject selected instead (the canonical identity or
  canonical location, often a generated one). A generated picture is never selected ahead of the creator's own photos.
- **After an upload** (`startingImagesAfterUpload`): every photo of the batch is selected, after whatever was selected
  before. A generated picture that was only selected by default gives way; a selection the creator made themselves is
  kept whole.
- **Choosing.** A click on a picture under "Start from" puts it in or takes it out. Selected pictures carry their number,
  which is the order they are sent in. The line under the pictures says how many are selected and that they are sent
  together; "Select all N of my photos" puts every photograph back; "Words only" selects nothing.
- **The stage follows.** Choosing starting images, or adding photos, puts them on the stage, all of them, numbered, at a
  size they can be checked at ("Back to take #N" returns to the result). A fresh visit opens on the starting images
  when a photograph was added after the newest picture was made (`opensOnStartingImages`), otherwise on that picture.
  "Show them large" puts the selection on the stage without changing it.
- **A take's own inputs are named as that take's** ("Take #4 was made from 3 images"), so what an older result started
  from is not mistaken for what the next one will start from.
- **Beside the button.** The images the server says it will send are pictured in order next to Generate, with their
  count ("Sends 4 images"); the same list, the prompt and the price are one click away. That list comes from the same
  preparation as the submission, so it is what is sent.
- **A model's limit.** A model takes a stated number of images in one request (GPT Image 16, the test model 8). Past
  it, the Studio says which pictures will be left out, before the request and in the count ("2 more did not fit this
  model").
- **A very long picture** (long side more than 2.2 times the short side, such as a full phone screenshot) is flagged:
  the person is probably small in the frame, and anything else in the picture is sent with them. The Studio has no
  crop tool yet; crop such a picture before adding it.
- **"Change an image" works on one picture.** Its choice is kept apart from the starting images, so switching between
  the two never loses either.

Code: `src/domain/generation/reference-studio.ts` (the three rules above, pure), `src/server/reference-studio.ts`
(`StudioImage.wardrobeOnly`, `.canonical`, `.addedAt`, `.test`; `StudioTake.test`), `src/components/studio/`
(`reference-studio.tsx` the selection, `source-picker.tsx` the brief, `stage.tsx` the stage).

## A fictional Character

A Character with no photo of their own (fictional, or no photo yet) opens the Studio on **Describe <name>**: their
written appearance, filled from the Character, with the Bible's role, description and personality beside it and a line
on what to say (age, origin, face, eyes, hair, build, anything distinctive). **Save** changes the Character's
appearance (`saveCharacterAppearance`); **Make the front view from this** fills in a Front portrait from words alone.
Judge it, drop it on Front, and make the other views from it. Once there are photos the description is a short note
under them, and the pictures win where the two differ. The Production checklist asks for "photos, or describe them".

## The reference set

A Character's **reference set** is the six views every Production Frame of that Character is made from: front,
3/4, left profile, right profile, half body and full body. Prism sends all of a Character's identity references with a Shot, the
canonical identity first, so the set is how "canonical from several angles" works: the **front view is the canonical
identity**, and the other views stand beside it.

- **On the stage**, under the take, the set shows what each view holds ("your photo", "take #10") or **Make it** for an
  empty view. Make it fills in the brief with that view's preset; nothing is made until Generate.
- **Into a view**: drag any picture (a tile under "Start from", or a take thumbnail) onto the view, or click
  **Choose** (**Change** on a filled view) and pick one. Dropping or choosing onto a filled view replaces its picture;
  the old one stays in the library.
- **On every finished take**, one control: the view it was made for is suggested, and the button says what happens
  ("Add to the set as 3/4 view", "Replace the front", "In the set as profile"). Replacing keeps the old picture in the
  library. A locked slot that holds an image is not replaced from here.
- **On each of the creator's own photos** (its facts, under "Start from"), the same control: a good real photo is the
  best reference there is.
- **What makes the best set** is written beside it: 4 to 8 good real photos, a view made from them and judged beside
  them, six views, a Look per outfit. The older "Use as canonical identity" and slot buttons remain under "Other
  uses".

Code: `REFERENCE_SET_VIEWS` and `referenceSetViewOf` in `src/domain/generation/reference-studio.ts`, `addToReferenceSet`
in `src/server/visual-bible-actions.ts`, `StudioState.referenceSet` in `src/server/reference-studio.ts`,
`src/components/studio/reference-set.tsx`. No migration: the views are the existing identity slots (the half body is an
extra reference marked `metadata.view = "half_body"`, the right profile likewise with `"right_profile"`; the
profile slot holds the left profile).

## What a Shot is sent

Once a Character's reference set holds a stored image, a Shot (its Production Frame) is sent the set, canonical first,
plus the expression and cutout designations. It is no longer also sent every plain extra reference, such as the
creator's raw photos: the set was made from them, sending both doubles the images, and a weak photo (a full phone
screenshot) pulls the likeness. Until the set holds an image nothing changes. (`liveAppearance` in
`src/domain/character-continuity.ts`; Continuity Locks freeze their own references and are unchanged.)

A Look's picture is sent with every Shot in that Look, and it shows a whole person. Each Look is a slot in the
reference-set panel: drag a take onto it, or **Choose**, and it becomes the Look's picture (the old one stays in the
library); **Make it** fills in a Wardrobe reference in that Look. A take made with a Look also offers **Make it the
picture of "…"**. A locked Look shows where to unlock it. The Reference Studio is first in the project navigation.

## Home and the Production checklist

The navigation is **Home**, the four areas (**Story**: Start from a prompt, Import Story, Bible, Script, Episodes; **Cast**: Characters,
Reference Studio; **World**: Locations; **Shots**: Storyboard, Sequence, Animatic), then **More tools** for every
specialist page. Home shows a card per area (where it stands, the one next thing, or what it waits on: a hint, never a
lock) and the first next steps. Any area can be worked on first.

### Starting from a prompt

The Projects page opens on one box: a title (optional: `titleFromPremise` names it otherwise), the description, Series /
Film / Short (a series picks its number of episodes: 6 · 8 · 10 · 12, or any whole number from 1 to 50) and the
language. The project is created with the premise in its Bible and its Episodes empty (a film or short has one,
"Screenplay"), and opens on `/projects/<project>/start`:

1. **Describe it**: the premise (an existing project without one can add it here; a written one is never overwritten).
2. **Plan the season** (series only): one brainstorm request on Episode 1, an idea per Episode (title + what happens).
   **Use this plan** writes each idea into its Episode's title and synopsis (no script). The plan is then **editable in
   place** (each title and synopsis, **Save plan**) and **Refine with Prism** takes a note: Prism gets the current plan
   (`seasonPlan` in the context) and returns the whole revised plan, shown beside yours; nothing changes until **Use
   this plan**. Refining is priced as a ceiling for the longest note (`REFINE_NOTE_MAX`). A plan of more than 10
   episodes records 10 as requested (the database's limit) and carries its real count in its context (`ideaCount`).
3. **Write it** (`WriteIt`): choose the writer (**Recommended by Prism**, or a named model; the free test writer is
   listed only on a test server, `PRISM_STUDIO_SHOW_TEST_MODELS=1`) and, for a series, **Episode N only** or **All N
   episodes**; a film is written whole. **Write…** opens a confirmation with the writer and the most it can cost;
   nothing runs before **Write** there. Each Episode (or the film) is ONE writing request (`length=whole`) that the
   Story worker writes in parts (`longFormPlan`: a series episode 2 × 8 000 tokens, a short 2 × 6 000, a film
   4 × 10 000), each part continuing from the tail of the text so far (`LONG_FORM_TAIL_CHARS`), into one proposal to
   review and accept on its Write page. Writing leases last 30 minutes (`WRITING_LEASE_MS`).
4. **Turn it into a Bible, cast, places and Shots**: Import Story on Episode 1 (or the film).
5. **Carry on in any order** from Home.

Every price is worked out by `priceWriting` (`src/server/writing-price.ts`), the same function the writing action uses,
so the confirmed amount is what each request is accepted at: a whole Episode is priced as a ceiling for every part; "all
episodes" is the sum of each Episode's own price, and each request still stays within the server's per-request limit
(`PRISM_STUDIO_STORY_AI_MAX_USD`). With no real writer switched on, the page says so instead of offering anything.

## Test models and real models

A deployment can switch on free **test models** ("Mock Image 1"). A test model draws a coloured pattern, never a
picture: it exists to prove the workflow (what is sent, what is kept, what is promoted) where nothing real can run.
Prism suggests a free model first, so on the hosted review site, where the test models are switched on, the owner made
two "pictures" with one on 2026-11-20, got two gradients, and asked for it to go.

- **Where a real model can be used, the Studio offers no test model** (`offersTestModels`), and shows nothing a test
  model made: no take, no picture under "Start from", no count on the subject. Nothing is deleted. The attempts and
  their files stay, and are shown again wherever test models are offered. A test pattern the Visual Bible uses stays in
  view, named as one, so it can be seen for what it is and replaced.
- **So on such a deployment the first Generate is a paid one.** The real model is selected from the start; its price
  is on the button before anything is made, and a picture starts only from that click, as for every paid picture.
- **Where no real model can be used** (local demo mode; a server with paid generation switched off), the test models
  are all there is, so they are offered and say what they are: "No charge: a test model. It draws a coloured pattern,
  not a real picture.", a button that reads **Generate test pattern**, and why the real model cannot be used ("paid
  generation is switched off", "not set up on this server"). A test model that is not switched on is not listed.
- **A test server that needs both** sets `PRISM_STUDIO_SHOW_TEST_MODELS=1` (the browser stories do: the free models do
  the generating while the paid one is priced). There the test model also offers the real one in one click, and its
  results are labelled on the take ("Test pattern, not a real picture"), under "Start from" ("test pattern") and in
  their line of facts.
- **The creator's choice of model is remembered in the browser** (`remembered-model.ts`, local storage), from one
  Character to the next and from one visit to the next. Only a choice the creator made is stored, never a suggestion,
  and a remembered paid model changes nothing about spending.

Not covered yet: the older panels on the Character page and the Location cards, and the video model pickers, still
list test models wherever the deployment switches them on (`PRISM_STUDIO_ENABLE_MOCK_PROVIDER`). The older image
panels already send a paid model to the Studio; their default is still the free test model.

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
  photo, not also a generated canonical image the creator did not pick. Four photos selected send those four, in the
  order they are numbered, and the wording speaks of them together ("the identity reference images", "the reference
  images win where they differ"). Nothing selected ("Words only") sends no identity image. A selected Look brings its
  words (its hair styling replaces the reference's). Its picture is sent only when none of the creator's own photos is
  chosen: a Look picture shows a whole person, and beside the creator's photos a model copied that person's face
  (hosted, 2026-11-20). The Wardrobe box says so; selecting the Look picture under "Start from" sends it anyway.
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
- **Each starting image adds to the price.** For GPT Image at standard quality the upper bound is $0.077 from words
  alone, $0.126 with one image, $0.271 with four, $0.465 with eight and $0.852 with sixteen (about $0.048 for each
  further image). The amount on the button always covers exactly the images pictured beside it, and the deployment's
  per-image ceiling still applies: where it is $0.50, a request with nine or more images is refused before anything
  is sent.
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

## Archive and delete

**Archive** (on a take, or on a selected starting image) takes a picture out of the Studio: out of the takes, out of
Start from, out of the subject's count, and never sent with anything. Nothing is deleted. The record is the Asset's own
`metadata.archived` (who it was archived from, when, and every plain pointer that was lifted out), so no schema change.

- Lifted out with it, and put back by **Restore**: an extra reference photo of a Character (a plain identity reference
  with no view or role), a Location's reference photo.
- Refused, with what to change first: a view of the reference set or the canonical identity, a Look's picture, a
  Location's designation, a locked reference, a use in a Shot (frames, continuity locks…).
- **Archived (N)**, under Start from: each archived picture with **Restore**, and **Delete permanently** (confirmed,
  can't be undone) only when nothing depends on it. Deleting a take's picture keeps the take in the history, with its
  cost, and no picture (it leaves the takes list; Spent is unchanged). A picture that was SENT to a take (a photo, or
  an earlier take) can't be deleted, so that take's record stays complete; the reason is shown in place of the button.

The rule for permanent deletion is one function (`src/server/asset-deletion.ts`), shared with the Assets library, so
the two never disagree.

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
- Browser: `e2e/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-reference-studio.spec.ts`, stories A to N, on its own memory server
  with the free test models. GPT Image is listed there as a paid worker-backed model with an empty key so its price can
  be shown; no story starts a paid image. Stories L and M cover the upload area in a real browser: several photos chosen
  and dropped, a file that is not a picture, a photo too large for one upload (the server states a 1 MB limit), and a
  photo stored turned, whose uploaded copy is checked pixel by pixel to be upright. Stories L, M and N cover several
  starting images: every photo of a batch selected and on the stage, the count and the prompt agreeing, the price of a
  second image shown before anything is made (story I), and a take made from three photos whose record lists each one.
  Stories A, C and I cover the test model on a server that asks for it: what it says it draws, the button that never
  promises a picture, the one click to the real model, and that model remembered after a reload and for the next
  Character.
- Browser, a real deployment: `e2e/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-reference-studio-real.spec.ts`, on a second
  memory server with the same real model and no `PRISM_STUDIO_SHOW_TEST_MODELS`: no test model is listed, the real one
  is selected, and its price is on the button from words alone and with two photographs. It never presses Generate.

## Deployment

- No migration. No new provider. Two optional environment variables: `PRISM_STUDIO_MAX_UPLOAD_BYTES` (leave it unset
  on Vercel) and `PRISM_STUDIO_SHOW_TEST_MODELS` (test servers only; leave it unset on any deployment a creator uses).
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

| Item        | Proposal                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input       | The owner's own photographs of the person who is Yumeko. Four were added on the hosted project on 2026-11-20; two are full phone screenshots (1080 × 2400), which are better cropped or left out. |
| Images      | Front portrait, 3/4 view, left profile, right profile, half body, full body: six images, each from the same selected photos.                                                                      |
| Model       | GPT Image 2.5 Flare, standard quality, portrait 2:3.                                                                                                                                              |
| Upper bound | With four photos about $0.27 each, about $1.63 for six; with one photo about $0.13 each, about $0.76 for six. Each image is under the workers' current $0.50 ceiling.                             |
| Expected    | Unknown for several starting images: nothing comparable has been billed here. With one starting image the one comparable hosted image cost $0.0243.                                               |
| Pass        | The owner looks at the six beside the photos and says whether it is the same person. Nothing is retried automatically.                                                                            |
| Needs       | The workers project redeployed from `main`, so the corrected first line of the prompt is what reaches the provider.                                                                               |
