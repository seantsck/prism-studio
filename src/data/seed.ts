import { createHash } from "node:crypto";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { buildShotContext } from "@/domain/context";
import { approvalSnapshot } from "@/domain/fingerprint";
import { parseScreenplay, renderScreenplay } from "@/domain/script";
import { makeShot } from "@/domain/shot-defaults";
import type {
  ActionBlock,
  Asset,
  Character,
  CharacterLook,
  ContinuityCheck,
  DialogueLine,
  GenerationAttempt,
  IdentityRef,
  Location,
  PerformanceDirection,
  PerformanceTake,
  ProjectData,
  Prop,
  Scene,
  Shot,
  StoryboardFrame,
  VoiceProfile,
  Waveform,
} from "@/domain/schemas";

/**
 * Demo fixtures for the Japanese drama "お嬢様、僕と結婚してください。".
 * Everything here is data; nothing in the product depends on these specific names.
 */

/** Deterministic UUID-shaped ids so the seed is stable across restarts and SQL exports. */
export function uid(key: string): string {
  const h = createHash("sha1").update(`prism-studio:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const LOCAL_USER_ID = uid("local-user");

/** Deterministic placeholder waveform so demo takes render a plausible shape (real peaks come from audio files). */
export function syntheticWaveform(key: string, durationMs: number, count = 120): Waveform {
  let x = parseInt(createHash("sha1").update(key).digest("hex").slice(0, 8), 16) || 1;
  const rand = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0xffffffff;
  };
  const peaks: number[] = [];
  for (let i = 0; i < count; i++) {
    const envelope = Math.sin((Math.PI * (i + 0.5)) / count) ** 0.6;
    peaks.push(Number(Math.min(1, 0.08 + envelope * (0.25 + 0.7 * rand())).toFixed(3)));
  }
  return { version: 1, sampleCount: count, peaks, durationMs };
}
const T0 = "2026-10-01T09:00:00.000Z";

export function buildSeedProject(): ProjectData {
  const projectId = uid("project");
  const episodeId = uid("ep1");

  // ── Assets (placeholders: no storage path until files are uploaded) ──
  const assets: Asset[] = [];
  const asset = (key: string, type: Asset["type"], name: string, extra: Partial<Asset> = {}): string => {
    const id = uid(`asset:${key}`);
    assets.push({
      id,
      projectId,
      createdBy: null,
      type,
      purpose:
        type === "audio"
          ? "performance_audio"
          : type === "image"
            ? "storyboard"
            : type === "reference"
              ? "identity_ref"
              : "other",
      source: "seed",
      name,
      originalFilename: "",
      storageProvider: "none",
      bucket: null,
      objectPath: null,
      mime: null,
      byteSize: null,
      checksum: null,
      width: type === "image" || type === "reference" ? 1920 : null,
      height: type === "image" || type === "reference" ? 1080 : null,
      durationMs: null,
      frameRate: null,
      sampleRate: null,
      channels: null,
      tags: [],
      notes: "",
      metadata: {},
      createdAt: T0,
      updatedAt: T0,
      ...extra,
    });
    return id;
  };

  // ── Characters ──
  const char = (key: string, c: Partial<Character> & Pick<Character, "name" | "role">): Character => ({
    id: uid(`char:${key}`),
    projectId,
    description: "",
    personality: "",
    behaviorNotes: "",
    physicalDescription: "",
    continuityRules: [],
    signatureBehavior: "",
    relationshipNotes: "",
    createdAt: T0,
    updatedAt: T0,
    ...c,
  });
  const yumeko = char("yumeko", {
    name: "Yumeko",
    role: "Lead — heiress",
    description: "Young heiress bound by a family arrangement she never chose.",
    personality: "Composed, dryly funny, privately exhausted.",
    behaviorNotes: "Controls her face in public; the mask slips for a half-second before she resets.",
    physicalDescription:
      "Late 20s Japanese woman, shoulder-length black hair, pale composed face, upright posture.",
    continuityRules: [
      "Always wears her mother's pearl earrings in Episode 1.",
      "Never smiles with teeth in public.",
    ],
    signatureBehavior: "Touches her left earring when lying.",
    relationshipNotes: "Strained with her mother; guarded with Takumi; curious about Sean.",
  });
  const sean = char("sean", {
    name: "Sean",
    role: "Lead — outsider",
    description: "Quietly persistent man who steps into the arrangement.",
    personality: "Warm, direct, unhurried.",
    physicalDescription: "Early 30s, short dark hair, lean build, calm eyes.",
    continuityRules: ["Wedding band is never visible in Episode 1."],
    relationshipNotes: "Sees Yumeko as a person, not a contract.",
  });
  const takumi = char("takumi", {
    name: "Takumi",
    role: "Antagonist — fiancé candidate",
    description: "Polished corporate heir who treats marriage as a merger.",
    personality: "Charming, transactional, condescending.",
    physicalDescription: "Mid 30s, immaculate swept hair, sharp features.",
    signatureBehavior: "Adjusts his cufflinks before making demands.",
  });
  const characters = [yumeko, sean, takumi];

  const identityRefs: IdentityRef[] = [];
  for (const c of characters) {
    const locked = c.id !== takumi.id;
    for (const slot of ["front", "three_quarter", "profile", "full_body"] as const) {
      if (c.id === takumi.id && slot !== "front") continue;
      identityRefs.push({
        id: uid(`identity:${c.name}:${slot}`),
        characterId: c.id,
        slot,
        assetId: asset(
          `identity:${c.name}:${slot}`,
          "reference",
          `${c.name} — ${slot.replace("_", " ")} (placeholder)`,
          {
            tags: ["identity", c.name.toLowerCase()],
          },
        ),
        label: slot.replace("_", " "),
        metadata: { note: "Placeholder; upload approved reference." },
        locked,
      });
    }
  }

  const look = (
    key: string,
    characterId: string,
    l: Partial<CharacterLook> & Pick<CharacterLook, "name">,
  ): CharacterLook => ({
    id: uid(`look:${key}`),
    projectId,
    characterId,
    episodeId,
    wardrobe: "",
    shoes: "",
    jewelry: "",
    hair: "",
    makeup: "",
    grooming: "",
    bodyNotes: "",
    accessories: "",
    referenceAssetIds: [],
    locked: true,
    ...l,
  });
  const yumekoLook = look("yumeko-formal", yumeko.id, {
    name: "Episode 1 — Formal Black",
    wardrobe: "Floor-length black satin evening gown, structured shoulders, high neckline, long sleeves",
    shoes: "Black pointed-toe stiletto heels with red soles",
    jewelry: "Mother's pearl drop earrings, no necklace",
    hair: "Sleek low chignon, a single loose strand at the left cheek",
    makeup: "Matte pale base, deep burgundy lip, defined brows",
    accessories: "Small black clutch",
  });
  const seanLook = look("sean-charcoal", sean.id, {
    name: "Episode 1 — Charcoal Suit",
    wardrobe: "Charcoal single-breasted suit, white shirt, slim dark navy tie",
    shoes: "Black oxford shoes",
    hair: "Short, neatly combed, slightly tousled at the front",
    grooming: "Clean-shaven",
  });
  const takumiLook = look("takumi-navy", takumi.id, {
    name: "Episode 1 — Navy Dinner Suit",
    wardrobe: "Navy double-breasted suit, pale blue shirt, silk pocket square",
    jewelry: "Silver cufflinks",
    locked: false,
  });
  const looks = [yumekoLook, seanLook, takumiLook];

  const voice = (c: Character, name: string, v: Partial<VoiceProfile>): VoiceProfile => ({
    id: uid(`voice:${c.name}`),
    projectId,
    characterId: c.id,
    name,
    language: "ja",
    locale: "ja-JP",
    provider: "unassigned",
    providerVoiceId: null,
    description: "",
    pitchNotes: "",
    timbreNotes: "",
    accent: "Standard Tokyo",
    speakingStyle: "",
    emotionalRange: "",
    pronunciationRules: [],
    sampleAssetIds: [],
    locked: false,
    ...v,
  });
  const voiceProfiles = [
    voice(yumeko, "Yumeko — Composed Alto", {
      description: "Controlled, low-mid female voice with a hint of weariness.",
      pitchNotes: "Low-mid; drops further when hiding emotion.",
      timbreNotes: "Smooth, slightly breathy at line ends.",
      speakingStyle: "Formal keigo in public, clipped plain form in private.",
      emotionalRange: "Restrained → brittle → rare warmth",
      pronunciationRules: ["夢子 = ゆめこ (Yumeko)"],
    }),
    voice(sean, "Sean — Warm Baritone", {
      description: "Warm, even male baritone.",
      speakingStyle: "Plain polite form; never raises volume.",
    }),
    voice(takumi, "Takumi — Polished Tenor", {
      description: "Smooth, confident tenor with a condescending edge.",
      speakingStyle: "Over-polite, deliberate pauses.",
    }),
  ];

  // ── Locations ──
  const loc = (key: string, l: Partial<Location> & Pick<Location, "name">): Location => ({
    id: uid(`loc:${key}`),
    projectId,
    description: "",
    geography: "",
    zones: [],
    entrances: [],
    lighting: "",
    recurringProps: [],
    referenceAssetIds: [],
    locked: true,
    set3d: null,
    ...l,
  });
  const zone = (key: string, name: string, description = "") => ({
    id: uid(`zone:${key}`),
    name,
    description,
  });
  const streets = loc("streets", {
    name: "Tokyo Night Streets",
    description: "Rain-slicked Tokyo avenue at night, neon signage reflected in wet asphalt.",
    geography: "Wide one-way avenue; hotel lies ahead on the right side of travel.",
    zones: [zone("st-road", "Roadway"), zone("st-curb", "Right curb")],
    lighting: "Sodium street lamps, magenta and cyan neon spill.",
  });
  const sedan = loc("sedan", {
    name: "Black Luxury Sedan",
    description: "Chauffeured black luxury sedan, leather interior, privacy glass.",
    geography:
      "Driver on the right. Yumeko sits rear LEFT (curb side when stopped at the hotel). Rear-left door opens to the curb.",
    zones: [
      zone("sd-rl", "Rear left seat"),
      zone("sd-rr", "Rear right seat"),
      zone("sd-front", "Front seats"),
    ],
    lighting: "Dim cabin, city light sweeping through windows.",
    recurringProps: ["Yumeko's phone", "Black clutch"],
  });
  const canopy = loc("canopy", {
    name: "Grand Celeste Hotel Canopy",
    description: "Illuminated hotel porte-cochère with red carpet and a line of press photographers.",
    geography:
      "Sedan stops under canopy, rear-left door facing the red carpet. Photographers stand on the carpet's far side, behind a velvet rope.",
    zones: [
      zone("cn-drop", "Drop-off point"),
      zone("cn-carpet", "Red carpet"),
      zone("cn-press", "Press line"),
    ],
    entrances: [
      {
        id: uid("ent:cn-doors"),
        name: "Revolving doors",
        description: "Lobby entrance, camera-left of carpet",
      },
    ],
    lighting: "Warm tungsten canopy lights, harsh white camera flashes.",
  });
  const lobby = loc("lobby", {
    name: "Grand Celeste Lobby",
    description: "Double-height marble lobby with a central chandelier and concierge desk.",
    geography: "Entrance at south, elevators on north wall, concierge desk west.",
    zones: [
      zone("lb-entry", "Entrance"),
      zone("lb-elev", "Elevator bank"),
      zone("lb-desk", "Concierge desk"),
    ],
    lighting: "Warm chandelier, polished reflective floor.",
  });
  const restaurant = loc("restaurant", {
    name: "Sky-View Restaurant",
    description: "Top-floor restaurant with floor-to-ceiling windows overlooking Tokyo.",
    geography: "Window wall to the east. Private table at the window; entrance at the west end.",
    zones: [zone("rs-table", "Window table"), zone("rs-entry", "Entrance"), zone("rs-bar", "Bar")],
    lighting: "Candlelight, city lights, low amber practicals.",
    recurringProps: ["Candles", "Wine glasses"],
  });
  const hallway = loc("hallway", {
    name: "Hotel Hallway",
    description: "Quiet upper-floor hotel corridor, patterned carpet, brass sconces.",
    geography: "Long corridor, elevator at one end, service door at the other.",
    zones: [zone("hw-mid", "Mid corridor"), zone("hw-elev", "Elevator end")],
    lighting: "Warm sconces, low contrast.",
    locked: false,
  });
  const locations = [streets, sedan, canopy, lobby, restaurant, hallway];

  const prop = (key: string, name: string, description: string): Prop => ({
    id: uid(`prop:${key}`),
    projectId,
    name,
    description,
    referenceAssetIds: [],
    locked: false,
  });
  const props = [
    prop("phone", "Yumeko's phone", "Black smartphone with a cracked pearl-white case"),
    prop("clutch", "Black clutch", "Small satin evening clutch with gold clasp"),
  ];

  // ── Scenes ──
  const scene = (n: number, slugline: string, locationId: string, extra: Partial<Scene>): Scene => ({
    id: uid(`scene:${n}`),
    projectId,
    episodeId,
    sceneNumber: String(n),
    slugline,
    intExt: slugline.startsWith("EXT") ? "EXT" : "INT",
    locationId,
    timeOfDay: "NIGHT",
    summary: "",
    dramaticPurpose: "",
    emotionEntering: "",
    emotionLeaving: "",
    scriptRange: null,
    characterIds: [],
    propIds: [],
    continuityNotes: "",
    order: n - 1,
    ...extra,
  });
  // Cast/prop membership is a set; the SQL adapter returns it sorted, so keep fixtures canonical.
  const canonicalScene = (sc: Scene): Scene => ({
    ...sc,
    characterIds: [...sc.characterIds].sort(),
    propIds: [...sc.propIds].sort(),
  });
  const scenes: Scene[] = [
    scene(1, "EXT. TOKYO NIGHT STREETS - NIGHT", streets.id, {
      summary: "A black sedan carries Yumeko toward the arrangement dinner.",
      dramaticPurpose: "Establish tone and Yumeko's isolation.",
      emotionEntering: "Numb",
      emotionLeaving: "Dread",
      characterIds: [yumeko.id],
    }),
    scene(2, "EXT. GRAND CELESTE HOTEL CANOPY - NIGHT", canopy.id, {
      summary: "Yumeko arrives to a wall of press and must perform composure.",
      dramaticPurpose: "Public mask vs. private reluctance.",
      emotionEntering: "Dread",
      emotionLeaving: "Brittle composure",
      characterIds: [yumeko.id],
      continuityNotes: "Rear-left door opens to the red carpet. Light rain has just stopped; carpet is damp.",
    }),
    scene(3, "INT. GRAND CELESTE LOBBY - NIGHT", lobby.id, {
      summary: "Alone for a moment, Yumeko lets the mask slip.",
      dramaticPurpose: "Private truth: she does not want to be here.",
      emotionEntering: "Brittle composure",
      emotionLeaving: "Resigned",
      characterIds: [yumeko.id],
    }),
    scene(4, "INT. SKY-VIEW RESTAURANT - NIGHT", restaurant.id, {
      summary: "Takumi treats the marriage as a deal; Yumeko pushes back.",
      dramaticPurpose: "First open defiance.",
      emotionEntering: "Resigned",
      emotionLeaving: "Resolute",
      characterIds: [yumeko.id, takumi.id],
    }),
    scene(5, "INT. HOTEL HALLWAY - NIGHT", hallway.id, {
      summary: "Her mother calls to remind her of her duty.",
      dramaticPurpose: "Family pressure.",
      emotionEntering: "Resolute",
      emotionLeaving: "Shaken",
      characterIds: [yumeko.id],
      propIds: [props[0].id],
    }),
    scene(6, "INT. SKY-VIEW RESTAURANT - NIGHT", restaurant.id, {
      summary: "Sean steps in with an unexpected proposal.",
      dramaticPurpose: "Inciting incident.",
      emotionEntering: "Shaken",
      emotionLeaving: "Stunned",
      characterIds: [yumeko.id, sean.id],
    }),
  ].map(canonicalScene);
  const sceneId = (n: number) => scenes[n - 1].id;

  // ── Dialogue + performance ──
  const dialogueLines: DialogueLine[] = [];
  const directions: PerformanceDirection[] = [];
  const takes: PerformanceTake[] = [];
  let lineOrder = 0;
  const line = (
    key: string,
    sceneNo: number,
    speaker: Character | string,
    text: string,
    extra: {
      locked?: boolean;
      context?: string;
      subtext?: string;
      translation?: string;
      direction?: Partial<PerformanceDirection>;
    },
  ): string => {
    const id = uid(`line:${key}`);
    const c = typeof speaker === "string" ? null : speaker;
    dialogueLines.push({
      id,
      projectId,
      episodeId,
      sceneId: sceneId(sceneNo),
      characterId: c?.id ?? null,
      speakerLabel: c ? c.name.toUpperCase() : (speaker as string),
      originalText: text,
      language: "ja",
      translation: extra.translation ?? null,
      pronunciationNotes: "",
      dramaticContext: extra.context ?? "",
      subtext: extra.subtext ?? "",
      locked: extra.locked ?? false,
      order: lineOrder++,
      sourceStartLine: null,
      sourceEndLine: null,
    });
    if (extra.direction) {
      directions.push({
        id: uid(`dir:${key}`),
        dialogueLineId: id,
        emotion: "",
        objective: "",
        subtext: extra.subtext ?? "",
        intensity: 40,
        pace: "natural",
        volume: "normal",
        pauses: "",
        breaths: "",
        emphasisNotes: "",
        physicalBehaviorNotes: "",
        ...extra.direction,
      });
    }
    return id;
  };
  const take = (
    lineId: string,
    characterId: string | null,
    n: number,
    durationMs: number,
    t: Partial<PerformanceTake> = {},
  ): void => {
    const id = uid(`take:${lineId}:${n}`);
    takes.push({
      id,
      projectId,
      dialogueLineId: lineId,
      characterId,
      voiceProfileId: characterId
        ? (voiceProfiles.find((v) => v.characterId === characterId)?.id ?? null)
        : null,
      sourceType: "temp_voice",
      audioAssetId: asset(`take:${lineId}:${n}`, "audio", `Take ${n} (placeholder audio)`, {
        durationMs,
        source: "seed",
      }),
      durationMs,
      durationSource: "seed",
      waveform: syntheticWaveform(`take:${lineId}:${n}`, durationMs),
      transcript: "",
      takeNumber: n,
      notes: "",
      rating: 0,
      selected: false,
      archived: false,
      createdAt: T0,
      ...t,
    });
  };

  const l2d = line("2d", 2, "REPORTER", "お嬢様、本日のご婚約についてお聞かせください！", {
    context: "Shouted over the flashes.",
    direction: {
      emotion: "Aggressive curiosity",
      objective: "Provoke a headline",
      intensity: 80,
      volume: "loud",
    },
  });
  take(l2d, null, 1, 3400, { selected: true, rating: 4, notes: "Good urgency." });

  const l2e = line("2e", 2, yumeko, "今夜は、何も申し上げることはございません。", {
    locked: true,
    context: "Public mask fully on.",
    subtext: "Leave me alone.",
    direction: {
      emotion: "Cold politeness",
      objective: "End the exchange without scandal",
      intensity: 35,
      pace: "slow",
      volume: "quiet",
      pauses: "Beat before 何も",
    },
  });
  take(l2e, yumeko.id, 1, 3900, { selected: true, rating: 4 });
  take(l2e, yumeko.id, 2, 4300, { rating: 3, notes: "Too slow." });

  const l3a = line("3a", 3, yumeko, "もう帰りたい……", {
    locked: true,
    context: "Alone, the mask slips for the first time.",
    subtext: "I can't do this.",
    translation: "I already want to go home…",
    direction: {
      emotion: "Exhausted vulnerability",
      objective: "Release the pressure unseen",
      intensity: 55,
      pace: "slow",
      volume: "whisper",
      breaths: "Exhale before the line",
      physicalBehaviorNotes: "Shoulders drop; eyes close briefly.",
    },
  });
  take(l3a, yumeko.id, 1, 2800, {
    selected: true,
    rating: 5,
    notes: "Canonical. Breath is perfect.",
    sourceType: "human_recording",
  });
  take(l3a, yumeko.id, 2, 3300, { rating: 3, notes: "Too drawn out." });
  take(l3a, yumeko.id, 3, 2400, { rating: 2, notes: "Rushed.", sourceType: "generated_voice" });

  const l4b = line("4b", 4, takumi, "結婚とは、条件の合う者同士の契約だよ。君も分かっているだろう？", {
    context: "Cufflink adjustment before the demand.",
    subtext: "You will comply.",
    direction: { emotion: "Smug certainty", objective: "Close the deal", intensity: 50, pace: "natural" },
  });
  take(l4b, takumi.id, 1, 4600, { rating: 3 });
  take(l4b, takumi.id, 2, 5000, { rating: 2 });

  const l4c = line("4c", 4, yumeko, "私は会社じゃない。人間です。", {
    locked: true,
    context: "First open defiance.",
    subtext: "I am not for sale.",
    translation: "I'm not a company. I'm a person.",
    direction: {
      emotion: "Quiet fury",
      objective: "Reclaim herself",
      intensity: 78,
      pace: "slow",
      volume: "normal",
      pauses: "Beat after じゃない",
    },
  });
  take(l4c, yumeko.id, 1, 3100, { selected: true, rating: 5, sourceType: "human_recording" });
  take(l4c, yumeko.id, 2, 2700, { rating: 4 });

  const l5aM = line("5a-mother", 5, "MOTHER (V.O.)", "約束は守りなさい、夢子。", {
    context: "Mother's voice through the phone.",
    direction: { emotion: "Cold authority", objective: "Enforce duty", intensity: 45 },
  });
  take(l5aM, null, 1, 2600, { selected: true, rating: 4 });
  const l5aY = line("5a-yumeko", 5, yumeko, "……分かっています、お母様。", {
    context: "Defeated reply.",
    direction: {
      emotion: "Subdued compliance",
      objective: "End the call",
      intensity: 30,
      pace: "slow",
      volume: "quiet",
    },
  });
  take(l5aY, yumeko.id, 1, 2300, { selected: true, rating: 4 });

  const l6a = line("6a", 6, sean, "お嬢様、僕と結婚してください。", {
    locked: true,
    context: "He says it plainly, without ceremony.",
    subtext: "I see you.",
    translation: "Miss, please marry me.",
    direction: {
      emotion: "Sincere calm",
      objective: "Be believed",
      intensity: 60,
      pace: "slow",
      volume: "normal",
    },
  });
  take(l6a, sean.id, 1, 3000, { rating: 4 });

  // ── Shots ──
  const shots: Shot[] = [];
  const FOUR_K_ASPECT = "2.39:1";
  const common = {
    composition: { aspectRatio: FOUR_K_ASPECT },
    continuity: { weather: "Light rain just stopped; wet surfaces", timeOfDay: "Night" },
  };
  const sh = (
    code: string,
    title: string,
    sceneNo: number,
    over: NonNullable<Parameters<typeof makeShot>[1]>,
  ): Shot => {
    const sceneShots = shots.filter((s) => s.sceneId === sceneId(sceneNo));
    const merged = {
      ...over,
      composition: { ...common.composition, ...over.composition },
      continuity: { ...common.continuity, ...over.continuity },
    };
    const s = makeShot(
      {
        id: uid(`shot:${code}`),
        projectId,
        episodeId,
        sceneId: sceneId(sceneNo),
        shotCode: code,
        title,
        order: sceneShots.length,
      },
      merged,
    );
    s.createdAt = T0;
    s.updatedAt = T0;
    shots.push(s);
    return s;
  };
  const prev = (code: string) => uid(`shot:${code}`);
  const approvedAll = { storyboardApproved: true, performanceApproved: true, continuityApproved: true };
  const withYumeko = (extra: Partial<Shot["characters"][number]> = {}, look = yumekoLook.id) => [
    {
      characterId: yumeko.id,
      lookId: look,
      performanceNotes: "",
      expression: "",
      posture: "",
      gestures: "",
      physicalInteractions: "",
      ...extra,
    },
  ];

  sh("1A", "Tokyo Establishing", 1, {
    storyBeat: "The city at night; the arrangement looms.",
    dramaticPurpose: "Set tone and world.",
    status: "approved",
    targetDurationMs: 4000,
    composition: {
      framing: "Wide aerial-style establishing",
      shotSize: "Extreme wide",
      movement: "Slow push-in",
      movementSpeed: "Very slow",
      lens: "24mm",
      cameraHeight: "High",
    },
    spatial: { locationId: streets.id, setZone: "Roadway" },
    continuity: { characterCount: 0, geography: "Hotel lies ahead on the right." },
    audio: { ambience: "Distant traffic, rain drip, muffled city hum" },
    lighting: { mood: "Neon-wet melancholy", colorTemperature: "Mixed sodium + neon" },
    approval: approvedAll,
  });
  sh("1B", "Sedan Exterior", 1, {
    storyBeat: "The black sedan glides through the neon rain.",
    dramaticPurpose: "Introduce the vehicle and its orientation.",
    status: "approved",
    targetDurationMs: 3500,
    composition: {
      framing: "Tracking beside vehicle",
      shotSize: "Medium wide",
      movement: "Parallel track",
      movementSpeed: "Match car",
      lens: "50mm",
      cameraHeight: "Low",
    },
    spatial: { locationId: streets.id, setZone: "Roadway", screenDirection: "Left to right" },
    continuity: {
      previousShotId: prev("1A"),
      characterCount: 0,
      vehicleInPlay: true,
      vehicleOrientation:
        "Driving left→right; passenger (curb) side toward camera; rear-left door on curb side",
    },
    audio: { ambience: "Engine hush, tyres on wet asphalt" },
    approval: approvedAll,
  });
  sh("1C", "Yumeko Reads Mother's Text", 1, {
    storyBeat: "Yumeko reads a terse message from her mother.",
    dramaticPurpose: "Establish family pressure through a single text.",
    status: "review",
    targetDurationMs: 4500,
    composition: {
      framing: "Over-the-shoulder on phone",
      shotSize: "Close-up",
      movement: "Static",
      lens: "85mm",
      aperture: "f/1.8",
      cameraAngle: "Slightly high",
    },
    spatial: {
      locationId: sedan.id,
      setZone: "Rear left seat",
      subjectBlocking: "Yumeko seated rear left, phone held low in both hands",
      eyelines: "Down to phone",
      screenDirection: "Faces screen-right",
    },
    characters: withYumeko({
      expression: "Blank, then a small tightening of the jaw",
      posture: "Upright, rigid",
    }),
    propIds: [props[0].id],
    continuity: { previousShotId: prev("1B"), characterCount: 1 },
    action: {
      beginningPose: "Phone lit in her hands",
      endingPose: "Thumb hovers over reply, then locks the screen",
      beats: [
        { id: uid("beat:1c:1"), order: 0, atMs: 0, description: "Screen illuminates her face" },
        { id: uid("beat:1c:2"), order: 1, atMs: 2500, description: "Jaw tightens" },
      ],
    },
    audio: { ambience: "Cabin hush, faint rain", musicCue: "Low sustained string bed" },
    lighting: { keyDirection: "Phone glow from below", mood: "Cold intimacy" },
    approval: { storyboardApproved: true, performanceApproved: true, continuityApproved: false },
  });
  sh("2A", "Sedan Under Canopy", 2, {
    storyBeat: "The sedan halts beneath the hotel canopy.",
    dramaticPurpose: "Arrival; the door side is established.",
    status: "prepping",
    targetDurationMs: 3000,
    composition: {
      framing: "Wide, three-quarter front",
      shotSize: "Wide",
      movement: "Slow push-in",
      lens: "35mm",
    },
    spatial: {
      locationId: canopy.id,
      setZone: "Drop-off point",
      screenDirection: "Car enters from screen-left",
    },
    continuity: {
      previousShotId: prev("1C"),
      characterCount: 0,
      vehicleInPlay: true,
      vehicleOrientation: "Stopped parallel to carpet; rear-left door faces red carpet",
    },
    audio: { ambience: "Muffled crowd, camera shutters" },
  });
  sh("2B", "Heel Steps Out", 2, {
    storyBeat: "A black stiletto touches the wet red carpet.",
    dramaticPurpose: "Her entrance as an image: the mask goes on.",
    status: "ready",
    targetDurationMs: 3000,
    composition: {
      framing: "Low angle on door threshold",
      shotSize: "Close-up (foot)",
      movement: "Slight tilt up",
      movementSpeed: "Slow",
      lens: "40mm",
      cameraHeight: "Ground level",
      cameraAngle: "Low",
    },
    spatial: {
      locationId: canopy.id,
      setZone: "Drop-off point",
      subjectBlocking: "Rear-left door open toward red carpet; heel lands first",
      eyelines: "n/a (foot)",
      screenDirection: "Out of car toward screen-right",
      entryPoint: "Rear-left door",
    },
    characters: withYumeko({ posture: "Controlled, deliberate", gestures: "Hand steadies on door frame" }),
    continuity: {
      previousShotId: prev("2A"),
      characterCount: 1,
      vehicleInPlay: true,
      vehicleOrientation: "Rear-left door (curb side) opens toward red carpet",
      wardrobe: "Formal Black; heels visible",
    },
    action: {
      beginningPose: "Door open, empty carpet",
      endingPose: "Heel planted on carpet, hem settling",
      beats: [
        { id: uid("beat:2b:1"), order: 0, atMs: 0, description: "Door swings open" },
        { id: uid("beat:2b:2"), order: 1, atMs: 1200, description: "Black heel lowers to the carpet" },
      ],
    },
    audio: { ambience: "Rising flashes and shutter bursts", foley: "Heel on damp carpet, fabric whisper" },
    lighting: {
      keyDirection: "Canopy overhead + flash from camera-right",
      colorTemperature: "3200K tungsten + white flash",
      mood: "Glamorous tension",
    },
    constraints: {
      hard: ["Heel must be black stiletto with red sole"],
      negative: ["No second woman", "No visible face"],
      forbiddenPeople: ["additional companion"],
    },
    approval: approvedAll,
  });
  sh("2C", "Yumeko POV Photographers", 2, {
    storyBeat: "The wall of photographers, seen through her eyes.",
    dramaticPurpose: "Overwhelm; she is an object of display.",
    status: "approved",
    targetDurationMs: 3500,
    composition: {
      framing: "POV",
      shotSize: "Medium wide",
      movement: "Handheld drift",
      movementSpeed: "Slow",
      lens: "35mm",
    },
    spatial: {
      locationId: canopy.id,
      setZone: "Press line",
      backgroundActivity: "Twelve photographers, flashes, velvet rope",
    },
    continuity: { previousShotId: prev("2B"), characterCount: 0 },
    audio: { ambience: "Roaring flashes, shouted questions" },
    approval: approvedAll,
  });
  sh("2D", "Reporter Question", 2, {
    storyBeat: "A reporter shouts the question everyone wants answered.",
    dramaticPurpose: "Force the public statement.",
    status: "review",
    durationMode: "derived_from_performance",
    targetDurationMs: 4500,
    composition: {
      framing: "Over-the-shoulder on reporter",
      shotSize: "Medium close-up",
      movement: "Static",
      lens: "85mm",
    },
    spatial: {
      locationId: canopy.id,
      setZone: "Press line",
      subjectBlocking: "Reporter leans over velvet rope",
      eyelines: "Toward Yumeko, off-camera right",
      screenDirection: "Faces screen-right",
    },
    continuity: { previousShotId: prev("2C"), characterCount: 0 },
    audio: { dialogueLineIds: [l2d], preRollMs: 300, postRollMs: 600, ambience: "Flashes, crowd" },
    approval: approvedAll,
  });
  sh("2E", "Yumeko Answers", 2, {
    storyBeat: "She answers with a composed non-answer.",
    dramaticPurpose: "Public mask holds.",
    status: "approved",
    durationMode: "derived_from_performance",
    targetDurationMs: 5000,
    composition: {
      framing: "Medium close-up, shallow focus",
      shotSize: "MCU",
      movement: "Slow push-in",
      lens: "85mm",
      aperture: "f/2",
    },
    spatial: {
      locationId: canopy.id,
      setZone: "Red carpet",
      subjectBlocking: "Yumeko faces camera at carpet centre",
      eyelines: "Slightly off-lens left",
      screenDirection: "Faces screen-left",
    },
    characters: withYumeko({ expression: "Perfectly composed", posture: "Upright, chin level" }),
    continuity: { previousShotId: prev("2D"), characterCount: 1 },
    action: {
      beginningPose: "Still, hands clasped on clutch",
      endingPose: "Small nod, gaze leaves lens",
      beats: [],
    },
    audio: {
      dialogueLineIds: [l2e],
      preRollMs: 500,
      postRollMs: 700,
      ambience: "Flashes fade under the line",
    },
    lighting: { keyDirection: "Flash front-right", mood: "Hard glamour" },
    approval: approvedAll,
  });
  sh("3A", "I Already Want to Go Home", 3, {
    storyBeat: "Alone at last, she exhales: she wants to go home.",
    dramaticPurpose: "The first private truth.",
    status: "ready",
    durationMode: "derived_from_performance",
    targetDurationMs: 4500,
    composition: {
      framing: "Medium close-up, centred",
      shotSize: "MCU",
      movement: "Imperceptible push-in",
      movementSpeed: "Very slow",
      lens: "85mm",
      aperture: "f/1.8",
      cameraHeight: "Eye level",
    },
    spatial: {
      locationId: lobby.id,
      setZone: "Elevator bank",
      subjectBlocking: "Yumeko stands at the elevator, back to the lobby",
      eyelines: "Down and away",
      screenDirection: "Faces screen-right",
    },
    characters: withYumeko({
      expression: "Mask drops; exhausted",
      posture: "Shoulders fall",
      gestures: "Closes eyes briefly",
    }),
    continuity: {
      previousShotId: prev("2E"),
      characterCount: 1,
      weather: "Indoors",
      wardrobe: "Formal Black",
    },
    action: { beginningPose: "Neutral, mask on", endingPose: "Eyes open, mask restored", beats: [] },
    audio: {
      dialogueLineIds: [l3a],
      preRollMs: 800,
      postRollMs: 900,
      ambience: "Hushed lobby, distant piano",
      silenceRequirements: "Nothing competes with the line",
    },
    lighting: { keyDirection: "Chandelier overhead-soft", mood: "Hushed, private" },
    approval: approvedAll,
  });
  sh("4A", "Dinner Establishing", 4, {
    storyBeat: "The restaurant, the city below, the table set for two.",
    dramaticPurpose: "Establish the stage for the confrontation.",
    status: "prepping",
    targetDurationMs: 3500,
    composition: {
      framing: "Wide, window silhouette",
      shotSize: "Wide",
      movement: "Slow dolly right",
      lens: "28mm",
    },
    spatial: { locationId: restaurant.id, setZone: "Window table" },
    continuity: { previousShotId: prev("3A"), characterCount: 0, weather: "Indoors" },
    audio: { ambience: "Cutlery, low conversation" },
  });
  sh("4B", "Takumi Overreaches", 4, {
    storyBeat: "Takumi frames the marriage as a contract.",
    dramaticPurpose: "Expose his transactional worldview.",
    status: "prepping",
    durationMode: "derived_from_performance",
    targetDurationMs: 6500,
    composition: { framing: "Over-the-shoulder", shotSize: "Medium", movement: "Static", lens: "50mm" },
    spatial: {
      locationId: restaurant.id,
      setZone: "Window table",
      subjectBlocking: "Takumi leans back, adjusting cufflink",
      eyelines: "Toward Yumeko screen-left",
    },
    characters: [
      {
        characterId: takumi.id,
        lookId: takumiLook.id,
        performanceNotes: "",
        expression: "Smug",
        posture: "Leaning back",
        gestures: "Adjusts cufflink",
        physicalInteractions: "",
      },
    ],
    continuity: { previousShotId: prev("4A"), characterCount: 1, weather: "Indoors" },
    audio: { dialogueLineIds: [l4b], preRollMs: 500, postRollMs: 800 },
  });
  sh("4C", "I'm a Person, Not a Company", 4, {
    storyBeat: "She refuses to be a deal.",
    dramaticPurpose: "First open defiance.",
    status: "review",
    durationMode: "derived_from_performance",
    targetDurationMs: 5000,
    composition: {
      framing: "Tight close-up",
      shotSize: "CU",
      movement: "Static",
      lens: "100mm",
      aperture: "f/1.4",
    },
    spatial: {
      locationId: restaurant.id,
      setZone: "Window table",
      subjectBlocking: "Yumeko leans slightly forward",
      eyelines: "Directly to Takumi (off-camera left)",
      screenDirection: "Faces screen-right",
    },
    characters: withYumeko({ expression: "Controlled fury", posture: "Forward, still" }),
    continuity: { previousShotId: prev("4B"), characterCount: 1, weather: "Indoors" },
    audio: { dialogueLineIds: [l4c], preRollMs: 600, postRollMs: 1000, ambience: "Room tone drops away" },
    lighting: { keyDirection: "Candle from below-left", mood: "Intimate, charged" },
    approval: { storyboardApproved: true, performanceApproved: true, continuityApproved: false },
  });
  sh("5A", "Mother Phone Call", 5, {
    storyBeat: "Her mother reminds her of her duty by phone.",
    dramaticPurpose: "Family pressure closes the vice.",
    status: "prepping",
    durationMode: "derived_from_performance",
    targetDurationMs: 7000,
    composition: { framing: "Profile two-beat", shotSize: "MCU", movement: "Static", lens: "70mm" },
    spatial: {
      locationId: hallway.id,
      setZone: "Mid corridor",
      subjectBlocking: "Yumeko against the wall, phone at ear",
      eyelines: "Down corridor",
      screenDirection: "Faces screen-left",
    },
    characters: withYumeko({ expression: "Shaken" }),
    propIds: [props[0].id],
    continuity: { previousShotId: prev("4C"), characterCount: 1, weather: "Indoors" },
    audio: { dialogueLineIds: [l5aM, l5aY], preRollMs: 400, postRollMs: 900, interLineGapMs: 600 },
  });
  sh("6A", "Sean Appears", 6, {
    storyBeat: "A stranger steps up and proposes.",
    dramaticPurpose: "Inciting incident.",
    status: "draft",
    durationMode: "derived_from_performance",
    targetDurationMs: 5000,
    composition: { framing: "Two-shot, rack focus", shotSize: "Medium" },
    spatial: { locationId: restaurant.id },
    characters: [
      {
        characterId: sean.id,
        lookId: seanLook.id,
        performanceNotes: "",
        expression: "Calm, direct",
        posture: "Upright",
        gestures: "",
        physicalInteractions: "",
      },
      {
        characterId: yumeko.id,
        lookId: yumekoLook.id,
        performanceNotes: "",
        expression: "Stunned",
        posture: "",
        gestures: "",
        physicalInteractions: "",
      },
    ],
    continuity: { previousShotId: prev("5A"), characterCount: 2, weather: "Indoors" },
    audio: { dialogueLineIds: [l6a], preRollMs: 500, postRollMs: 1200 },
  });

  // ── Storyboard frames ──
  const frames: StoryboardFrame[] = [];
  const frame = (code: string, approved: boolean, version = 1, notes = "") => {
    const shotId = uid(`shot:${code}`);
    frames.push({
      id: uid(`frame:${code}:${version}`),
      projectId,
      shotId,
      assetId: asset(`frame:${code}:${version}`, "image", `${code} storyboard v${version}`, {
        source: "sketch",
        tags: ["storyboard"],
      }),
      version,
      source: "sketch",
      notes,
      approved,
      approvedFingerprint: null,
      approvedSnapshot: null,
      approvedAt: null,
      createdAt: T0,
    });
  };
  for (const code of ["1A", "1B", "1C", "2B", "2C", "2D", "2E", "3A", "4C", "5A"]) frame(code, code !== "5A");
  frame("4A", false, 1, "First pass — framing too tight.");
  frame("2B", false, 2, "Alternate with wider hem.");

  // Seed script text consistent with scenes + lines (keeps IDs stable on re-sync).
  const actions: Record<string, string[]> = {
    [sceneId(1)]: [
      "Rain-slick avenues glow with neon. A black luxury sedan glides through traffic.",
      "In the rear seat, YUMEKO reads a text message.",
    ],
    [sceneId(2)]: [
      "The sedan halts under the canopy. Photographers surge against the rope.",
      "A black heel touches the red carpet.",
    ],
    [sceneId(3)]: ["The lobby is hushed. Yumeko stands alone at the elevators."],
    [sceneId(4)]: ["Candlelight. TAKUMI adjusts a cufflink across the table."],
    [sceneId(5)]: ["Yumeko leans against the corridor wall, phone at her ear."],
    [sceneId(6)]: ["SEAN approaches the table and stops."],
  };
  const byScene: Record<string, Array<{ speaker: string; text: string }>> = {};
  for (const l of dialogueLines)
    (byScene[l.sceneId] ??= []).push({ speaker: l.speakerLabel, text: l.originalText });
  const scriptText = renderScreenplay(scenes, actions, byScene);

  // ── Script traceability: stable action-block ids + source line ranges, derived from the rendered script ──
  const actionBlocks: ActionBlock[] = [];
  parseScreenplay(scriptText).forEach((parsedScene, i) => {
    const scene = scenes[i];
    if (!scene) return;
    scene.scriptRange = { startLine: parsedScene.startLine, endLine: parsedScene.endLine };
    const sceneLines = dialogueLines.filter((l) => l.sceneId === scene.id).sort((a, b) => a.order - b.order);
    let a = 0;
    let d = 0;
    for (const block of parsedScene.blocks) {
      if (block.kind === "action") {
        actionBlocks.push({
          id: uid(`action:${i + 1}:${a}`),
          projectId,
          episodeId,
          sceneId: scene.id,
          text: block.text,
          order: a++,
          startLine: block.line,
          endLine: block.endLine,
        });
      } else {
        const line = sceneLines[d++];
        if (line) {
          line.sourceStartLine = block.line;
          line.sourceEndLine = block.endLine;
        }
      }
    }
  });
  // Which action block each shot was made from (index within its scene). 6A is deliberately left
  // unlinked so the demo shows an uncovered beat.
  const SOURCE_LINKS: Record<string, number[]> = {
    "1A": [0],
    "1B": [0],
    "1C": [1],
    "2A": [0],
    "2B": [1],
    "2C": [0],
    "3A": [0],
    "4A": [0],
    "5A": [0],
  };
  for (const shot of shots) {
    const idx = SOURCE_LINKS[shot.shotCode];
    if (!idx) continue;
    const sceneBlocks = actionBlocks
      .filter((b) => b.sceneId === shot.sceneId)
      .sort((x, y) => x.order - y.order);
    shot.scriptSources.actionBlockIds = idx.map((n) => sceneBlocks[n]?.id).filter((x): x is string => !!x);
  }

  const episode = {
    id: episodeId,
    projectId,
    number: 1,
    slug: "ep-1",
    title: "The Arrangement",
    synopsis: "Yumeko arrives at a staged engagement dinner and, for the first time, says what she wants.",
    scriptText,
    order: 0,
    createdAt: T0,
    updatedAt: T0,
  };

  const data: ProjectData = {
    project: {
      id: projectId,
      userId: LOCAL_USER_ID,
      title: "お嬢様、僕と結婚してください。",
      slug: "ojousama",
      projectType: "series",
      description:
        "A Japanese romantic drama about an heiress, an arrangement, and the man who proposes anyway.",
      genre: "Romantic drama",
      tone: "Restrained, wry, emotionally precise",
      defaultLanguage: "ja",
      productionStatus: "pre_production",
      createdAt: T0,
      updatedAt: T0,
    },
    bible: {
      projectId,
      premise: "An heiress bound to a family-arranged marriage meets a man who proposes without conditions.",
      genre: "Romantic drama",
      tone: "Restrained, wry, emotionally precise",
      visualStyle:
        "Cinematic night photography, rich blacks, practical-lit interiors, shallow depth of field.",
      cinematographyRules: [
        "Static or very slow movement for private moments; handheld only for press chaos.",
        "Longer lenses (70–100mm) for emotional close-ups.",
        "Keep the horizon level; avoid Dutch angles.",
      ],
      colorLanguage:
        "Deep black and burgundy for duty; warm amber for private truth; cool neon for the outside world.",
      aspectRatio: "2.39:1",
      defaultFrameRate: 24,
      dialogueLanguageStrategy: "Original Japanese dialogue; no dubbing.",
      subtitleStrategy: "English burned-in subtitles in post; none in generation.",
      audioPhilosophy: "Silence is scored. Let breath and room tone carry private moments.",
      canonFacts: [
        "Yumeko's mother's pearl earrings are a family heirloom.",
        "The arrangement dinner is at the Grand Celeste Hotel.",
        "Episode 1 takes place in a single night.",
      ],
      continuityRules: [
        "Yumeko's Formal Black Look does not change within Episode 1.",
        "The sedan's rear-left door is the curb-side door at the hotel.",
        "Light rain stopped before arrival; exterior surfaces remain wet.",
      ],
      guardrails: [
        "Never silently rewrite approved dialogue.",
        "Never change a locked character Look.",
        "Never add characters not assigned to a shot.",
        "Never change a locked location/set.",
        "Never change weather unless the shot explicitly permits it.",
        "Never move a vehicle door to the wrong side.",
        "Never invent additional companions.",
      ],
      updatedAt: T0,
    },
    assets,
    characters,
    identityRefs,
    looks,
    voiceProfiles,
    locations,
    props,
    episodes: [episode],
    scenes,
    shots,
    dialogueLines,
    actionBlocks,
    directions,
    takes,
    frames,
    attempts: [],
    continuityChecks: [],
  };

  // ── Generation history for 2B (never overwritten) ──
  const pkg = assembleGenerationPackage(buildShotContext(data, uid("shot:2B")), new Date(T0));
  const attempt = (
    n: number,
    status: GenerationAttempt["status"],
    extra: Partial<GenerationAttempt>,
  ): GenerationAttempt => ({
    id: uid(`attempt:2B:${n}`),
    projectId,
    shotId: uid("shot:2B"),
    attemptNumber: n,
    provider: "unassigned",
    model: "manual-log",
    modality: "video",
    prompt: pkg.prompt.positive,
    negativePrompt: pkg.prompt.negative,
    packageSnapshot: JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>,
    packageFingerprint: pkg.provenance.fingerprint,
    modelSettings: {},
    inputAssetIds: [],
    outputAssetId: null,
    costUsd: null,
    durationMs: 3000,
    status,
    rejectionReason: "",
    notes: "",
    approved: false,
    createdAt: T0,
    ...extra,
  });
  data.attempts = [
    attempt(1, "rejected", {
      rejectionReason: "Wrong car door — opened on the road side.",
      notes: "Vehicle orientation not respected.",
    }),
    attempt(2, "rejected", {
      rejectionReason: "Extra woman appeared in frame.",
      notes: "Added a companion.",
    }),
    attempt(3, "approved", { approved: true, notes: "Correct door, single subject." }),
  ];
  const check: ContinuityCheck = {
    id: uid("continuity:2B:3"),
    projectId,
    shotId: uid("shot:2B"),
    attemptId: uid("attempt:2B:3"),
    kind: "manual",
    overallScore: 92,
    scores: {
      characterIdentity: 90,
      wardrobe: 95,
      hair: null,
      makeup: null,
      jewelry: null,
      set: 95,
      props: 100,
      lighting: 88,
      geography: 95,
      actionContinuity: 90,
      characterCount: 100,
    },
    issues: [
      {
        dimension: "lighting",
        severity: "minor",
        description: "Flash is slightly cooler than the canopy tungsten.",
      },
    ],
    reviewer: "Director",
    createdAt: T0,
  };
  data.continuityChecks = [check];

  // Approved frames are fresh at seed time: record what they were approved against.
  for (const f of data.frames) {
    if (!f.approved) continue;
    const { fingerprint, snapshot } = approvalSnapshot(buildShotContext(data, f.shotId));
    f.approvedFingerprint = fingerprint;
    f.approvedSnapshot = { parts: snapshot.parts as Record<string, string>, durationMs: snapshot.durationMs };
    f.approvedAt = T0;
  }
  return data;
}
