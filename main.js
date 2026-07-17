const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const memoryjs = require('memoryjs');
const fs = require('fs');

const processName = "ffxiv_dx11.exe";
const BASE_OFFSET = 0x02A8C550;
//----------------------------------------动态内存地址，游戏更新失效先看这个--------------------------------------------

let win;
let updateInterval;
let gameHandle = null;
let modBaseAddr = null;

let isBatchMode = false;
let anchorPre = null;
let anchorPost = null;
let deltaAngle = 0;
let anchorPrePtr = null;
let anchorPostPtr = null;
let lastFurniturePtr = null;
let isLocalMode = false;

let gameProcess = null;

const CURRENT_VERSION = "0.0.6"; // 更新版本——打包前记得改这里

// 两个下载和检测源
const UPDATE_SOURCES = [
    // 渠道1：Gitee
    "https://gitee.com/Yan-Shui-Yun/Cooling-Down-The-House/raw/main/update.json",

    // 渠道2：GitHub
    "https://raw.githubusercontent.com/Yan-Shui-Yun/Cooling-Down-The-House/master/update.json"
];

//
async function checkUpdateWithFallback() {
    for (const url of UPDATE_SOURCES) {
        try {
            console.log(`正在尝试请求更新: ${url}`);
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 5000);

            const cacheBusterUrl = `${url}?t=${Date.now()}`;
            const response = await fetch(cacheBusterUrl, { signal: controller.signal });
            clearTimeout(id);

            if (!response.ok) continue;

            const data = await response.json();
            console.log("成功获取新版本数据:", data);

            if (data.latestVersion !== CURRENT_VERSION) {
                let finalDownloadUrl = "";

                if (Array.isArray(data.downloadUrl)) {
                    finalDownloadUrl = data.downloadUrl[0] || "https://github.com/Yan-Shui-Yun/Cooling-Down-The-House/releases";
                } else {
                    finalDownloadUrl = data.downloadUrl;
                }

                if (win && !win.isDestroyed()) {
                    win.webContents.send('update-available', {
                        version: data.latestVersion,
                        url: finalDownloadUrl, // 把最稳网址发给前端
                        log: data.updateLog
                    });
                }
            }
            return;

        } catch (err) {
            console.warn(`源 ${url} 请求失败，正在切换下一个...`, err.message);
        }
    }
    console.log("尝试更新失败。");
}

function connectGame() {
    if (gameProcess && gameProcess.handle) return true;
    try {
        gameProcess = memoryjs.openProcess(processName);
        console.log("成功连接游戏");
        return true;
    } catch (e) {
        gameProcess = null;
        return false;
    }
}

function readMemoryAndSync() {
    //if (!win || win.isDestroyed()) return;
    if (isScanning) return;
    if (!connectGame()) return;

    try {
        //const processObject = memoryjs.openProcess(processName);
        const handle = gameProcess.handle;
        const modBaseAddr = gameProcess.modBaseAddr;

        //版本更新可能要改的地方
        let ptr = memoryjs.readMemory(handle, modBaseAddr + BASE_OFFSET, memoryjs.INT64);
        if (!ptr || ptr === 0n) throw new Error("没找到基址");
        ptr = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x40n), memoryjs.INT64);
        if (!ptr || ptr === 0n) throw new Error("未选中家具");
        ptr = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x18n), memoryjs.INT64);
        if (!ptr || ptr === 0n) throw new Error("未选中家具");

        const two_X = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x50n), memoryjs.FLOAT);
        const two_Y = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x54n), memoryjs.FLOAT);
        const two_Z = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x58n), memoryjs.FLOAT);
        const quat_Y = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x64n), memoryjs.FLOAT);
        const quat_W = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x6Cn), memoryjs.FLOAT);

        if (isNaN(two_X) || Math.abs(two_X) > 100000.0) throw new Error("数据异常");

        // 算角度
        let currentAngleDeg = 2 * Math.atan2(quat_Y, quat_W) * (180 / Math.PI);

        win.webContents.send('sync-memory', {
            selected: true,
            x: two_X,
            y: two_Y,
            z: two_Z,
            r: currentAngleDeg
        });

    } catch (error) {
        // 如果上面任何一步失败（游戏没开、没选中家具），就给前端发 0
        win.webContents.send('sync-memory', {
            selected: false,
            x: 0,
            y: 0,
            z: 0,
            r: 0
        });
        if (error.message !== "未选中家具" && error.message !== "数据异常" && error.message !== "没找到基址") {
            gameProcess = null;
        }
    }
}

//保存窗口位置
const configPath = path.join(app.getPath('userData'), 'config.json');

function createWindow () {
  //默认的窗口配置
  let windowOptions = {
    width: 350,
    height: 460,
    resizable: false, //固定窗口大小
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true //不要动
    }
  };

  //尝试读取上一次保存的位置
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config && typeof config.x === 'number' && typeof config.y === 'number') {
        windowOptions.x = config.x; // 注入上一次的 X 坐标
        windowOptions.y = config.y; // 注入上一次的 Y 坐标
      }
    }
  } catch (e) {
    console.error("读取位置配置失败:", e.message);
  }

  //用包含坐标的配置创建窗口
  win = new BrowserWindow(windowOptions);

  win.loadFile('index.html'); // 加载前端网页

  //每 200 毫秒（0.2秒）读取一次内存并发给前端
  updateInterval = setInterval(() => {
    readMemoryAndSync();
    monitorFurnitureSelection();
  }, 200);

  //在窗口即将关闭时，记录它当前在屏幕上的位置
  win.on('close', () => {
    try {
      if (win) {
        const pos = win.getPosition(); // 获取当前窗口的 [x, y] 坐标
        const configData = {
          x: pos[0],
          y: pos[1]
        };
        // 写入本地 config.json 文件
        fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8');
      }
    } catch (e) {
      console.error("保存位置配置失败:", e.message);
    }
  });

  //窗口创建后，延迟 1.5 秒开始检查更新
    setTimeout(() => {
        checkUpdateWithFallback();
    }, 1500);


}

//用于计算旋转向量
function rotateVector(x, z, theta) {
    const rad = -(theta * Math.PI) / 180; // 角度转弧度
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
        x: x * cos - z * sin,
        z: x * sin + z * cos
    };
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  clearInterval(updateInterval);
  if (gameHandle) {
      memoryjs.closeProcess(gameHandle);
      gameHandle = null;
  }
  if (process.platform !== 'darwin') app.quit();
});


function writeToMemory(data) {
    let tempProcess = null;
    console.log("新数据:", data);
    try {
        //const processObject = memoryjs.openProcess(processName);
        tempProcess = memoryjs.openProcess(processName);
        const handle = tempProcess.handle;
        const modBaseAddr = tempProcess.modBaseAddr;//获取动态基址

        let ptr = memoryjs.readMemory(handle, modBaseAddr + BASE_OFFSET, memoryjs.INT64);
        if (!ptr || ptr === 0 || ptr === 0n) {
            memoryjs.closeProcess(handle);
            return;
        }
        ptr = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x40n), memoryjs.INT64);
        if (!ptr || ptr === 0 || ptr === 0n) {
            console.log("\n请先在旋转模式下选中家具");
            memoryjs.closeProcess(handle);
            return;
        }
        ptr = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x18n), memoryjs.INT64);
        if (!ptr || ptr === 0 || ptr === 0n) {
            console.log("\n请先在旋转模式下选中家具");
            memoryjs.closeProcess(handle);
            return;
        }



        //源头动态地址-XYZ轴
        const REAL_X_ADDRESS = Number(BigInt(ptr) + 0x50n);
        const REAL_Y_ADDRESS = Number(BigInt(ptr) + 0x54n);
        const REAL_Z_ADDRESS = Number(BigInt(ptr) + 0x58n);
        // 旋转四元数地址
        const REAL_RX_ADDRESS = Number(BigInt(ptr) + 0x60n); // 旋转X
        const REAL_RY_ADDRESS = Number(BigInt(ptr) + 0x64n); // 旋转Y
        const REAL_RZ_ADDRESS = Number(BigInt(ptr) + 0x68n); // 旋转Z
        const REAL_RW_ADDRESS = Number(BigInt(ptr) + 0x6Cn); // 旋转W
        //计算四元数
        const targetAngleRad = data.r * (Math.PI / 180);
        const new_quat_Y = Math.sin(targetAngleRad / 2);
        const new_quat_W = Math.cos(targetAngleRad / 2);

        //写入新坐标
        memoryjs.writeMemory(handle, REAL_X_ADDRESS, data.x, memoryjs.FLOAT);
        memoryjs.writeMemory(handle, REAL_Y_ADDRESS, data.y, memoryjs.FLOAT);
        memoryjs.writeMemory(handle, REAL_Z_ADDRESS, data.z, memoryjs.FLOAT);
        // 写入新四元数
        memoryjs.writeMemory(handle, REAL_RX_ADDRESS, 0.0, memoryjs.FLOAT);
        memoryjs.writeMemory(handle, REAL_RY_ADDRESS, new_quat_Y, memoryjs.FLOAT);
        memoryjs.writeMemory(handle, REAL_RZ_ADDRESS, 0.0, memoryjs.FLOAT);
        memoryjs.writeMemory(handle, REAL_RW_ADDRESS, new_quat_W, memoryjs.FLOAT);

        memoryjs.closeProcess(handle);

    } catch (error) {
        console.error("写入失败:", error.message);
    }finally {
        if (tempProcess) {
            try { memoryjs.closeProcess(tempProcess.handle); } catch(e) {}
        }
    }

}

// 专门用于在批量移动前，抓取当前游戏内真实的坐标和角度
function readCurrentCoords() {
    let tempProcess = null;
    try {
        //const processObject = memoryjs.openProcess(processName);
        tempProcess = memoryjs.openProcess(processName);
        const handle = tempProcess.handle;
        const modBaseAddr = tempProcess.modBaseAddr;

        let ptr = memoryjs.readMemory(handle, modBaseAddr + BASE_OFFSET, memoryjs.INT64);
        if (!ptr || ptr === 0n) return null;;
        ptr = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x40n), memoryjs.INT64);
        if (!ptr || ptr === 0n) return null;;
        ptr = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x18n), memoryjs.INT64);
        if (!ptr || ptr === 0n) return null;;

        // 计算坐标和角度的内存地址
        const REAL_X_ADDRESS = Number(BigInt(ptr) + 0x50n);
        const REAL_Y_ADDRESS = Number(BigInt(ptr) + 0x54n);
        const REAL_Z_ADDRESS = Number(BigInt(ptr) + 0x58n);

        const REAL_RY_ADDRESS = Number(BigInt(ptr) + 0x64n); // 四元数 Y
        const REAL_RW_ADDRESS = Number(BigInt(ptr) + 0x6Cn); // 四元数 W

        // 1. 读取坐标
        const currentX = memoryjs.readMemory(handle, REAL_X_ADDRESS, memoryjs.FLOAT);
        const currentY = memoryjs.readMemory(handle, REAL_Y_ADDRESS, memoryjs.FLOAT);
        const currentZ = memoryjs.readMemory(handle, REAL_Z_ADDRESS, memoryjs.FLOAT);

        // 2. 读取四元数并反算出角度（度数）
        const qY = memoryjs.readMemory(handle, REAL_RY_ADDRESS, memoryjs.FLOAT);
        const qW = memoryjs.readMemory(handle, REAL_RW_ADDRESS, memoryjs.FLOAT);

        let rad = 2 * Math.atan2(qY, qW);
        let deg = rad * (180 / Math.PI);
        if (deg < 0) deg += 360; // 规整到 0~360 度

        memoryjs.closeProcess(handle);

        return { x: currentX, y: currentY, z: currentZ, r: deg, ptr: ptr };
    } catch (error) {
        console.error("读取当前坐标失败:", error.message);
        return null;
    } finally {
        if (tempProcess) {
            try { memoryjs.closeProcess(tempProcess.handle); } catch(e) {}
        }
    }
}

ipcMain.on('write-memory', (event, data) => {
        writeToMemory(data);
});

// 监听前端“录入起点”请求
ipcMain.on('record-anchor-pre', (event) => {
    const coords = readCurrentCoords();
    if (coords) {
        anchorPre = coords;
        anchorPrePtr = coords.ptr;
        console.log("已记录起始标杆:", anchorPre);
        sendAnchorStatus(event.sender);
    }
});

// 监听前端“录入终点”请求
ipcMain.on('record-anchor-post', (event) => {
    const coords = readCurrentCoords();
    if (coords) {
        anchorPost = coords;
        anchorPostPtr = coords.ptr;
        console.log("已记录目标标杆:", anchorPost);
        sendAnchorStatus(event.sender);
    }
});

// 统一把当前的标杆状态发给前端
function sendAnchorStatus(webContents) {
    webContents.send('anchor-updated', {
        pre: anchorPre,
        post: anchorPost
    });
}

function handleFurnitureMove(currentMemPos) {
    // 两个标杆都已经设置完毕，否则不执行
    if (!anchorPre || !anchorPost) {
        return;
    }

    // 计算角度差
    let deltaAngle = anchorPost.r - anchorPre.r;

    // 当前位置和起始标杆的向量差
    let relX = currentMemPos.x - anchorPre.x;
    let relZ = currentMemPos.z - anchorPre.z;

    // 将向量进行旋转
    let rotated = rotateVector(relX, relZ, deltaAngle);

    // 计算最终坐标（起点 + 旋转后的向量差）
    let finalX = anchorPost.x + rotated.x;
    let finalZ = anchorPost.z + rotated.z;

    let deltaY = anchorPost.y - anchorPre.y;
    let finalY = currentMemPos.y + deltaY;

    let finalAngle = currentMemPos.r + deltaAngle;

    // 保留5位小数精度
    let safePosToWrite = {
        x: parseFloat(finalX.toFixed(5)),
        y: parseFloat(finalY.toFixed(5)),
        z: parseFloat(finalZ.toFixed(5)),
        r: parseFloat(finalAngle.toFixed(3))
    };

    // 写入内存
    writeToMemory(safePosToWrite);
    console.log("检测到新家具，已执行位移：", safePosToWrite);
    console.log("safePosToWrite");
}


// 关闭批量模式时，自动清空标杆数据
ipcMain.on('toggle-batch-mode', (event, isEnabled) => {
    isBatchMode = isEnabled;
    if (!isBatchMode) {
        anchorPre = null;
        anchorPost = null;
        anchorPrePtr = null;
        anchorPostPtr = null;
        console.log("已关闭批量模式，清空标杆");
        sendAnchorStatus(event.sender);
    }
});

function monitorFurnitureSelection() {
    let tempProcess = null;
    //if (!isBatchMode) return;
    try {
        //const processObject = memoryjs.openProcess(processName);
        tempProcess = memoryjs.openProcess(processName);
        const handle = tempProcess.handle;
        const modBaseAddr = tempProcess.modBaseAddr;

        let ptr = memoryjs.readMemory(handle, modBaseAddr + BASE_OFFSET, memoryjs.INT64);
        if (!ptr || ptr === 0n) return;
        ptr = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x40n), memoryjs.INT64);
        if (!ptr || ptr === 0n) return;
        ptr = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x18n), memoryjs.INT64);
        if (!ptr || ptr === 0n) return;

        // 检测鼠标点选别的家具
        if (lastFurniturePtr !== null && lastFurniturePtr !== ptr) {
            //选中的是标杆本身取消加向量
            if (ptr === anchorPrePtr || ptr === anchorPostPtr) {
                console.log("选中标杆家具，免疫位移");
            }
            //如果不是标杆，且标杆已经录入完毕，执行位移
            else if (anchorPre && anchorPost) {
                console.log("检测到新家具，准备位移");
                const currentMemPos = readCurrentCoords();
                if (currentMemPos) {
                    handleFurnitureMove(currentMemPos);
                }
            }
        }
        lastFurniturePtr = ptr;
        memoryjs.closeProcess(handle);
    } catch (error) {
        // 忽略
    }finally {
        if (tempProcess) {
            try { memoryjs.closeProcess(tempProcess.handle); } catch(e) {}
        }
    }
}

ipcMain.on("open-help", () => {
    const helpWindow = new BrowserWindow({
        width: 500,
        height: 510,
        resizable: true,
        autoHideMenuBar: true,
        webPreferences:{
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true
        }
    });
    //helpWindow.webContents.openDevTools();//控制台

    helpWindow.loadFile("help.html");

});

ipcMain.on("set-always-on-top", (event, value) => {
    win.setAlwaysOnTop(value, 'screen-saver');
});

ipcMain.on('open-external-url', (event, url) => {
    shell.openExternal(url);
});

ipcMain.on('toggle-batch-mode', (event, isEnabled) => {
    isBatchMode = isEnabled;
    console.log("批量移动:", isBatchMode);
    //关闭模式清零数据
    if (!isBatchMode) {
        anchorPre = null;
        anchorPost = null;
        deltaAngle = 0;
    }
});


ipcMain.handle('get-background-path', () => {
  return path.join(process.resourcesPath, 'assets', 'Background.png');
});

ipcMain.on('set-coord-mode', (event, isLocal) => {
    isLocalMode = isLocal;
    console.log(`当前移动模式已切换为: ${isLocalMode ? 'Local' : 'World'}`);
});

//下面的是local和world模式下的数据接收
ipcMain.on('nudge-furniture', (event, data) => {
    // 批量模式下禁止手动微调
    //if (isBatchMode) return;

    // axis: 'x', 'y', 'z', 或 'r'
    // amount: 要加减的数值
    const { axis, amount } = data;

    const currentPos = readCurrentCoords();
    if (!currentPos) return;

    let deltaX = 0;
    let deltaY = 0;
    let deltaZ = 0;
    let deltaR = 0;

    // Y和R不受 Local/World 影响
    if (axis === 'y') {
        deltaY = amount;
    } else if (axis === 'r') {
        deltaR = amount;
    }
    // X和Z根据坐标系模式计算
    else if (axis === 'x' || axis === 'z') {
        if (isLocalMode) {
            // Local
            let localX = (axis === 'x') ? amount : 0;
            let localZ = (axis === 'z') ? amount : 0;

            let rotated = rotateVector(localX, localZ, currentPos.r);
            deltaX = rotated.x;
            deltaZ = rotated.z;
        } else {
            // World
            if (axis === 'x') deltaX = amount;
            if (axis === 'z') deltaZ = amount;
        }
    }
    let safePosToWrite = {
        x: parseFloat((currentPos.x + deltaX).toFixed(5)),
        y: parseFloat((currentPos.y + deltaY).toFixed(5)),
        z: parseFloat((currentPos.z + deltaZ).toFixed(5)),
        r: parseFloat((currentPos.r + deltaR).toFixed(3))
    };
    // 写入内存！
    writeToMemory(safePosToWrite);
});

//监听前端的窗口大小调整请求
ipcMain.on('resize-window', (event, { width, height }) => {
    if (win) {
        win.setBounds({
            width: width,
            height: height
        }, true);
    }
});

//解除限制
//-------------------------------版本更新可能要改-------------------------------
let placeAnywhereAddr = null;
let wallAnywhereAddr = null;
let wallmountAnywhereAddr = null;
let isScanning = false;

ipcMain.on('toggle-hack', (event, isEnable) => {
    if (isScanning) return;
    isScanning = true;

    let tempProcess = null;
    try {
        tempProcess = memoryjs.openProcess(processName);
        const handle = tempProcess.handle;

        //扫描一次并缓存
        if (!placeAnywhereAddr || !wallAnywhereAddr || !wallmountAnywhereAddr) {
            console.log("正在扫描内存特征码，请稍候...");

            const flags = memoryjs.NORMAL || 0;


            const pattern1 = "C6 83 ? ? 00 00 00 0F 29 44 24";
            const res1 = memoryjs.findPattern(handle, processName, pattern1, flags, 0);
            if (res1 && res1 !== -1) placeAnywhereAddr = res1 + 6;

            const pattern2 = "48 85 C0 74 ? C6 87 ? ? 00 00 00";
            const res2 = memoryjs.findPattern(handle, processName, pattern2, flags, 0);
            if (res2 && res2 !== -1) wallAnywhereAddr = res2 + 11;

            const pattern3 = "C6 87 83 01 00 00 00 48 83 C4";
            const res3 = memoryjs.findPattern(handle, processName, pattern3, flags, 0);
            if (res3 && res3 !== -1) wallmountAnywhereAddr = res3 + 6;

            console.log(`[特征码扫描完成] \n通用放置: ${placeAnywhereAddr}\n墙壁吸附: ${wallAnywhereAddr}\n壁挂限制: ${wallmountAnywhereAddr}`);
        }

        if (!placeAnywhereAddr || !wallAnywhereAddr || !wallmountAnywhereAddr) {
            console.log("特征码扫描失败");
            //扫描失重置缓存
            placeAnywhereAddr = null;
            wallAnywhereAddr = null;
            wallmountAnywhereAddr = null;
            return;
        }

        const targetByte = isEnable ? 0x01 : 0x00;
        const bufferToWrite = Buffer.from([targetByte]);
        const PAGE_EXECUTE_READWRITE = 0x40;

        const addresses = [placeAnywhereAddr, wallAnywhereAddr, wallmountAnywhereAddr];
        addresses.forEach(addr => {
            memoryjs.virtualProtectEx(handle, addr, 1, PAGE_EXECUTE_READWRITE);
            memoryjs.writeBuffer(handle, addr, bufferToWrite);
        });

        if (isEnable) {
            console.log("已解除摆放限制");
        } else {
            console.log("已恢复摆放限制");
        }

    } catch (error) {
        console.error("特征码注入失败:", error.message);
    } finally {
        if (tempProcess) {
            try { memoryjs.closeProcess(tempProcess.handle); } catch(e) {}
        }
    }
    isScanning = false;
});

