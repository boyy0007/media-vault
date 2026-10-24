/// <reference path="../pb_data/types.d.ts" />
// 360° photos and videos. media.pano is how to show the item (see pb_public/pano.js):
//   ""         a normal flat photo/video
//   "equirect" a stitched 360 panorama (2:1)
//   "fisheye"  Insta360 raw dual-fisheye (.insp / .insv / .lrv)
// Detected in the browser at upload (detectPano()); the owner can change it in the viewer's info panel.
// Locked items keep the same value inside their encrypted meta.

migrate((app) => {
  const media = app.findCollectionByNameOrId("media");
  media.fields.add(new SelectField({ name: "pano", maxSelect: 1, values: ["equirect", "fisheye"] }));
  app.save(media);
}, (app) => {
  const media = app.findCollectionByNameOrId("media");
  media.fields.removeByName("pano");
  app.save(media);
});
