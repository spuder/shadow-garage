// Cut settings per material. v1 supports one material: white sticker paper, cut with the AutoBlade.
// More colors/thicknesses are new entries here; later, entries in src/lib/paperTypes.ts can point at
// a cutMaterialId so choosing a paper type also chooses its cut settings.

export interface CutMaterial {
  id: string;
  name: string;
  /** Silhouette media id (Graphtec.py MEDIA table). Informational on the Cameo 3, which doesn't take an FW command. */
  mediaId: number;
  pressure: number; // 1..33
  speed: number; // 1..10 on the Cameo 3
  autoBladeDepth: number; // 0..10, set by the AutoBlade itself via TF
}

// Starting values are inkscape-silhouette's "Sticker Sheet" entry (media 134). They have not yet
// been tuned on real hardware for a clean kiss cut — adjust after test cuts. Note: per upstream,
// a pressure of 19 or more makes the Cameo run its track-enhancing roller pass automatically.
export const WHITE_STICKER_PAPER: CutMaterial = {
  id: "white-sticker-paper",
  name: "White sticker paper",
  mediaId: 134,
  pressure: 20,
  speed: 10,
  autoBladeDepth: 1,
};

export const CUT_MATERIALS: CutMaterial[] = [WHITE_STICKER_PAPER];
