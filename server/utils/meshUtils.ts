// @ts-nocheck
import fs from 'fs'
import path from 'path'
import { getBoxCenter } from './transform2latlon'

//! Read OBJ data.
function read_obj(objFilePath) {
    let points = [], faces = [], normals = [];
    let data = fs.readFileSync(objFilePath, 'utf8');
    let dataList = data.split('\n');
    for (let j = 0; j < dataList.length; j++) {
        if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "v") {
            points.push([parseFloat(dataList[j].split(" ")[1]), parseFloat(dataList[j].split(" ")[2]), parseFloat(dataList[j].split(" ")[3])]);
        } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "f") {
            faces.push([parseInt(dataList[j].split(" ")[1]), parseInt(dataList[j].split(" ")[2]), parseInt(dataList[j].split(" ")[3])]);
        } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "vn") {
            normals.push([parseFloat(dataList[j].split(" ")[1]), parseFloat(dataList[j].split(" ")[2]), parseFloat(dataList[j].split(" ")[3])]);
        }
    }
    return [points, faces, normals];
}

//! Merge untextured OBJ files from different areas.
async function merge_obj(savePath, objFilePaths) {
    let cursor = 0;
    let slow_cursor = 0;
    let facesStr = [];
    const ws = fs.createWriteStream(savePath, {
        flags: 'w',
        encoding: 'utf-8',
        highWaterMark: 3
    })
    for (let i = 0; i < objFilePaths.length; i++) {
        if (i == 0) {
            let data = fs.readFileSync(objFilePaths[i], 'utf8');
            let dataList = data.split('\n');
            for (let j = 0; j < dataList.length; j++) {
                if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "v") {
                    cursor++;
                    ws.write(dataList[j] + "\n");
                } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "f") {
                    let tempFace = dataList[j].split(" ");
                    let newStr = "f ";
                    for (let k = 0; k < tempFace.length - 1; k++) {
                        if (k == tempFace.length - 2) {
                            newStr += (parseInt(tempFace[k + 1])).toString() + "\n";
                        } else {
                            newStr += (parseInt(tempFace[k + 1])).toString() + " ";
                        }
                    }
                    facesStr.push(newStr);
                }
            }
        } else {
            slow_cursor = cursor;
            let data = fs.readFileSync(objFilePaths[i], 'utf8');
            let dataList = data.split('\n');
            for (let j = 0; j < dataList.length; j++) {
                if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "v") {
                    cursor++;
                    ws.write(dataList[j] + "\n");
                } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "f") {
                    let tempFace = dataList[j].split(" ");
                    let newStr = "f ";
                    for (let k = 0; k < tempFace.length - 1; k++) {
                        if (k == tempFace.length - 2) {
                            newStr += (parseInt(tempFace[k + 1]) + slow_cursor).toString() + "\n";
                        } else {
                            newStr += (parseInt(tempFace[k + 1]) + slow_cursor).toString() + " ";
                        }
                    }
                    facesStr.push(newStr);
                }
            }
        }
    }
    for (let i = 0; i < facesStr.length; i++) {
        ws.write(facesStr[i]);
    }

    await new Promise((resolve, reject) => {
        ws.end(() => {
            resolve(null);
        });
        ws.on('error', reject);
    });

    console.log("merge successfully!");
}

//! Merge untextured OBJ files from different areas.
function simple_merge_obj(savePath, objFilePaths) {
    let facesStr = [];
    let vts_str = [];
    let vns_str = [];
    const ws = fs.createWriteStream(savePath, {
        flags: 'w',
        encoding: 'utf-8',
        highWaterMark: 3
    })
    for (let i = 0; i < objFilePaths.length; i++) {
        if (i == 0) {
            let data = fs.readFileSync(objFilePaths[i], 'utf8');
            let dataList = data.split('\n');
            for (let j = 0; j < dataList.length; j++) {
                if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "v") {
                    ws.write(dataList[j] + "\n");
                } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "f") {
                    facesStr.push(dataList[j] + "\n");
                } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "vt") {
                    vts_str.push(dataList[j]);
                } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "vn") {
                    vns_str.push(dataList[j]);
                }
            }
        } else {
            let data = fs.readFileSync(objFilePaths[i], 'utf8');
            let dataList = data.split('\n');
            for (let j = 0; j < dataList.length; j++) {
                if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "v") {
                } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "f") {
                    facesStr.push(dataList[j] + "\n");
                } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "vt") {
                } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "vn") {
                }
            }
        }
    }
    ws.write("# UV\n");
    for (let ii = 0; ii < vts_str.length; ii++) {
        ws.write(vts_str[ii] + '\n');
    }
    ws.write("# Normals\n");
    for (let ii = 0; ii < vns_str.length; ii++) {
        ws.write(vns_str[ii] + '\n');
    }
    ws.write("# faces\n");
    for (let ii = 0; ii < facesStr.length; ii++) {
        ws.write(facesStr[ii]);
    }

    ws.close();
    console.log("merge successfully!");
}

//! Merge textured OBJ files.
function merge_obj_with_texture(savePath, objFilePaths) {
    let cursor = 0;
    let slow_cursor = 0;
    let tex_num = -1;
    let vts_str = [];
    let vns_str = [];
    let facesStr = [];
    const ws = fs.createWriteStream(savePath + "/model.obj", {
        flags: 'w',
        encoding: 'utf-8',
        highWaterMark: 3
    })
    ws.write("mtllib model.mtl\n");
    for (let i = 0; i < objFilePaths.length; i++) {
        slow_cursor = cursor;
        let fname = path.basename(objFilePaths[i]);
        let fpath = objFilePaths[i].split(fname)[0];
        let data = fs.readFileSync(objFilePaths[i], 'utf8');
        let dataList = data.split('\n');
        for (let j = 0; j < dataList.length; j++) {
            if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "v") {
                cursor++;
                ws.write(dataList[j] + "\n");
            } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "vt") {
                vts_str.push(dataList[j]);
            } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "vn") {
                vns_str.push(dataList[j]);
            } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "f") {
                let tempFace = dataList[j].split(" ");
                let newStr = "f ";
                for (let k = 0; k < tempFace.length - 1; k++) {
                    let num = parseInt(tempFace[k + 1].split("/")[0]) + slow_cursor
                    let tempStr = num + "/" + num + "/" + num
                    if (k == tempFace.length - 2) {
                        newStr += tempStr + "\n";
                    } else {
                        newStr += tempStr + " ";
                    }
                }
                facesStr.push(newStr);
            } else if (dataList[j].includes(" ") && dataList[j].split(" ")[0] == "usemtl") {
                tex_num += 1;
                if (tex_num >= 1) {
                    ws.write("# UV\n");
                    for (let ii = 0; ii < vts_str.length; ii++) {
                        ws.write(vts_str[ii] + '\n');
                    }
                    vts_str = [];
                    ws.write("# Normals\n");
                    for (let ii = 0; ii < vns_str.length; ii++) {
                        ws.write(vns_str[ii] + '\n');
                    }
                    vns_str = [];
                    ws.write("# faces\n");
                    for (let ii = 0; ii < facesStr.length; ii++) {
                        ws.write(facesStr[ii]);
                    }
                    facesStr = [];
                }
                ws.write("usemtl tex_temp_" + tex_num + "\n");
                ws.write("o planet_temp_" + tex_num + "\n");
                ws.write("# vertices\n");
                // Copy the texture.
                let tex_name = dataList[j].split(" ")[1];
                fs.copyFileSync(fpath + tex_name + ".jpg", savePath + "/tex_temp_" + tex_num + ".jpg")
            }
        }
    }
    ws.write("# UV\n");
    for (let ii = 0; ii < vts_str.length; ii++) {
        ws.write(vts_str[ii] + '\n');
    }
    ws.write("# Normals\n");
    for (let ii = 0; ii < vns_str.length; ii++) {
        ws.write(vns_str[ii] + '\n');
    }
    ws.write("# faces\n");
    for (let ii = 0; ii < facesStr.length; ii++) {
        ws.write(facesStr[ii]);
    }

    ws.close();
    const ws2 = fs.createWriteStream(savePath + "/model.mtl", {
        flags: 'w',
        encoding: 'utf-8',
        highWaterMark: 3
    })
    for (let i = 0; i <= tex_num; i++) {
        ws2.write("newmtl tex_temp_" + i + "\nKd 1.000 1.000 1.000\nd 1.0\nillum 0\nmap_Kd tex_temp_" + i + ".jpg\n\n");
    }

    ws2.close();
    console.log("merge successfully!");
}

//! Experimental clipped-OBJ identification.
function objMerge_sameRange(objFolderPath, overlapPolygon, editType, transform, tilesetCenter) {
    // Merge ground and buildings by using ground as the base and appending building faces.
    let buildingsObjPath = objFolderPath + "/buildings.obj";
    let groundObjPath = objFolderPath + "/ground.obj";
    let editObjPath = objFolderPath + "/model_edit.obj";

    const ws = fs.createWriteStream(editObjPath, {
        flags: 'w',
        encoding: 'utf-8',
        highWaterMark: 3
    })
    ws.write("mtllib model.mtl\n");

    let tileList = [];
    let buildingsPoints = [];

    let groundData = fs.readFileSync(groundObjPath, 'utf8');
    let groundDataList = groundData.split('\n');

    // Read ground files directly.
    let index = 0;
    let tempTileInfo;
    for (let j = 0; j < groundDataList.length; j++) {

        if (groundDataList[j].includes(" ") && groundDataList[j].split(" ")[0] == "usemtl") {
            // Store information about the previous tile.
            if (tempTileInfo) {
                tileList.push(tempTileInfo);
            }
            tempTileInfo = {
                points: [],
                faces: [],
                vts: [],
                vns: [],
                tex_num: index++,
                des: [],
            }
            tempTileInfo.des.push(groundDataList[j]);

        } else if (groundDataList[j].includes(" ") && groundDataList[j].split(" ")[0] == "v") {

            // editObjPointsList.push(groundDataList[j]);
            tempTileInfo.points.push(groundDataList[j]);

            let p = groundDataList[j].split(" ");
            buildingsPoints.push(getBoxCenter(transform, [tilesetCenter[0] + parseFloat(p[1]), tilesetCenter[1] + parseFloat(p[2]), tilesetCenter[0] + parseFloat(p[3])], true));


        } else if (groundDataList[j].includes(" ") && groundDataList[j].split(" ")[0] == "vn") {

            // editObjVnList.push(groundDataList[j]);
            tempTileInfo.vns.push(groundDataList[j]);

        } else if (groundDataList[j].includes(" ") && groundDataList[j].split(" ")[0] == "f") {

            // editObjFacesList.push(groundDataList[j]);
            tempTileInfo.faces.push(groundDataList[j]);
        } else if (groundDataList[j].includes(" ") && groundDataList[j].split(" ")[0] == "vt") {

            // editObjFacesList.push(groundDataList[j]);
            tempTileInfo.vts.push(groundDataList[j]);
        }

        // ws.write(groundDataList[j] + "\n");
    }

    // Store information about the final tile.
    if (tempTileInfo) {
        tileList.push(tempTileInfo);
    }

    let buildingsData = fs.readFileSync(buildingsObjPath, 'utf8');
    let buildingsDataList = buildingsData.split('\n');
    let buildingsFacesMerge = [];
    // Read and filter building data.
    index = -1;
    for (let j = 0; j < buildingsDataList.length; j++) {

        if (groundDataList[j].includes(" ") && groundDataList[j].split(" ")[0] == "usemtl") {
            // Store information about the previous tile.
            if (index >= 0 && buildingsFacesMerge.length > 0) {
                tileList[index].faces = tileList[index].faces.concat(buildingsFacesMerge);
                buildingsFacesMerge = [];
            }
            index++;
        } else if (buildingsDataList[j].includes(" ") && buildingsDataList[j].split(" ")[0] == "f") {
            let f = buildingsDataList[j].split(" ");
            let facePointIndex = [parseInt(f[1]), parseInt(f[2]), parseInt(f[3])];
            let facePoint = [buildingsPoints[facePointIndex[0] - 1], buildingsPoints[facePointIndex[1] - 1], buildingsPoints[facePointIndex[2] - 1]];
            for (let i = 0; i < facePoint.length; i++) {
                facePoint[i] = facePoint[i].slice(0, 2);
            }
            //! Select tiles that intersect or are contained by the overlap extent.
            // Write according to editType.
            if (turf.booleanPointInPolygon(turf.point(facePoint[0]), overlapPolygon) ||
                turf.booleanPointInPolygon(turf.point(facePoint[1]), overlapPolygon) ||
                turf.booleanPointInPolygon(turf.point(facePoint[2]), overlapPolygon)
            ) {
                if (editType == "delete") {
                    continue;
                } else {
                    // ws.write(buildingsDataList[j] + "\n");
                    // editObjFacesList.push(buildingsDataList[j]);
                    buildingsFacesMerge.push(buildingsDataList[j]);
                }
            } else {
                if (editType == "delete") {
                    // ws.write(buildingsDataList[j] + "\n");
                    // editObjFacesList.push(buildingsDataList[j]);
                    buildingsFacesMerge.push(buildingsDataList[j]);
                } else {
                    continue;
                }
            }
        }
    }

    // Store information about the final tile.
    if (buildingsFacesMerge.length > 0) {
        tileList[index].faces = tileList[index].faces.concat(buildingsFacesMerge);
        buildingsFacesMerge = [];
    }

    // Write tileList.
    for (let i = 0; i < tileList.length; i++) {
        let tile = tileList[i];
        for (let j = 0; j < tile.des.length; j++) {
            ws.write(tile.des[j] + "\n");
        }
        for (let j = 0; j < tile.points.length; j++) {
            ws.write(tile.points[j] + "\n");
        }
        for (let j = 0; j < tile.vts.length; j++) {
            ws.write(tile.vts[j] + "\n");
        }
        for (let j = 0; j < tile.vns.length; j++) {
            ws.write(tile.vns[j] + "\n");
        }
        for (let j = 0; j < tile.faces.length; j++) {
            ws.write(tile.faces[j] + "\n");
        }
    }
    ws.close();

}




export {
    merge_obj,
    merge_obj_with_texture,
    read_obj,
    simple_merge_obj,
    objMerge_sameRange
}
