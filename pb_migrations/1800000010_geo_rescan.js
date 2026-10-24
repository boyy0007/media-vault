/// <reference path="../pb_data/types.d.ts" />
// Locations used to be read from JPEG photos only. pb_public/mediainfo.js now also reads HEIC/PNG/WebP photos
// and phone videos, so mark the items the old reader couldn't look inside as unchecked: the map scans them
// again the next time it's opened (scanLocations() in app.js).

migrate((app) => {
  app.db().newQuery(`
    UPDATE media SET geoDone = FALSE
    WHERE COALESCE(lat, 0) = 0 AND COALESCE(lng, 0) = 0 AND kind IN ('image', 'video')
      AND LOWER(file) NOT LIKE '%.jpg' AND LOWER(file) NOT LIKE '%.jpeg'
  `).execute();
}, () => {});
