// Future KHOJ image/person matching adapter.
//
// Current production mode is intentionally heuristic-only. This adapter is a
// stable boundary for a later Kumbh Mela/KHOJ image model, and must never block
// lost/found report creation if the model is absent, slow, or unavailable.

export async function compareLostFoundPhotos() {
  return {
    available: false,
    score: 0,
    reason: "khoj_image_model_not_configured",
  };
}
