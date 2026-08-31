// @ts-nocheck
import * as Cesium from 'cesium'

function webMercator2lonLat(mercator) {
    let lonlat = { x: 0, y: 0, z: 0 };
    let pi = Math.PI;
    let R = Math.sqrt(
        mercator.x * mercator.x +
        mercator.y * mercator.y +
        mercator.z * mercator.z
    );
    let Latitude = (180.0 / pi) * Math.atan2(mercator.y, mercator.x);
    let Longitude = (180.0 / pi) * Math.asin(mercator.z / R);
    let Height = R - 6371010;
    lonlat.x = Latitude;
    lonlat.y = Longitude;
    lonlat.z = Height;
    return lonlat;
};

function lonlat2ellipsoid(Latitude, Longitude, Height) {
    let radian_x = (Latitude / 180) * Math.PI;
    let radian_y = (Longitude / 180) * Math.PI;
    let height_min = Height;

    let ellipsod_a = 40680631590769;
    let ellipsod_b = 40680631590769;
    let ellipsod_c = 40408299984661.445;

    let xn = Math.cos(radian_x) * Math.cos(radian_y);
    let yn = Math.sin(radian_x) * Math.cos(radian_y);
    let zn = Math.sin(radian_y);

    let x0 = ellipsod_a * xn;
    let y0 = ellipsod_b * yn;
    let z0 = ellipsod_c * zn;
    let gamma = Math.sqrt(xn * x0 + yn * y0 + zn * z0);
    let px = x0 / gamma;
    let py = y0 / gamma;
    let pz = z0 / gamma;

    let dx = xn * height_min;
    let dy = yn * height_min;
    let dz = zn * height_min;
    let center = {};
    center.x = px + dx;
    center.y = py + dy;
    center.z = pz + dz;
    return center;
};

function pointTransform(point, transform) {
    let c = [];
    point = [...point, 1.0];
    c[0] = point[0] * transform[0] + point[1] * transform[4] + point[2] * transform[8] + point[3] * transform[12];
    c[1] = point[0] * transform[1] + point[1] * transform[5] + point[2] * transform[9] + point[3] * transform[13];
    c[2] = point[0] * transform[2] + point[1] * transform[6] + point[2] * transform[10] + point[3] * transform[14];
    c[3] = point[0] * transform[3] + point[1] * transform[7] + point[2] * transform[11] + point[3] * transform[15];
    return c;
}

function webMercatorToCartographic(x, y, z = 0) {
    const projection = new Cesium.WebMercatorProjection();
    return projection.unproject(new Cesium.Cartesian3(x, y, z));
}

function googleEllipsoid2NormalEllipsoid(x, y, z) {
    var googleEllipsoid = new Cesium.Ellipsoid(6371010, 6371010, 6371010);
    var normalEllipsoid = new Cesium.Ellipsoid(6378137, 6378137, 6356752.314245179);

    // Keep original branch for Cartesian3 based tiles.
    var cartesian = new Cesium.Cartesian3(x, y, z);
    var p1 = normalEllipsoid.cartesianToCartographic(cartesian);

    return p1;
}

// webMer indicates whether transformed 3dtiles coordinates are EPSG:3857.
function getBoxCenter(transform, boxCenter, webMer = true) {
    let transformPoint = pointTransform(boxCenter, transform);

    let cartographic;
    if (webMer) {
        cartographic = webMercatorToCartographic(transformPoint[0], transformPoint[1], transformPoint[2]);
    } else {
        cartographic = googleEllipsoid2NormalEllipsoid(transformPoint[0], transformPoint[1], transformPoint[2]);
    }

    return [
        Cesium.Math.toDegrees(cartographic.longitude),
        Cesium.Math.toDegrees(cartographic.latitude),
        cartographic.height,
    ];
}

function getBoxScope(transform, box, webMer = true) {
    const center = box.slice(0, 3);
    const halfX = Math.abs(box[3]);
    const halfY = Math.abs(box[7]);
    const halfZ = Math.abs(box[11]);

    const corners = [
        pointTransform([center[0] - halfX, center[1] - halfY, center[2] - halfZ], transform),
        pointTransform([center[0] + halfX, center[1] - halfY, center[2] - halfZ], transform),
        pointTransform([center[0] + halfX, center[1] + halfY, center[2] - halfZ], transform),
        pointTransform([center[0] - halfX, center[1] + halfY, center[2] - halfZ], transform),
    ];

    return corners.map((p) => {
        const c = webMer
            ? webMercatorToCartographic(p[0], p[1], p[2])
            : googleEllipsoid2NormalEllipsoid(p[0], p[1], p[2]);

        return [
            Cesium.Math.toDegrees(c.longitude),
            Cesium.Math.toDegrees(c.latitude),
        ];
    });
}

export { getBoxCenter, getBoxScope }
