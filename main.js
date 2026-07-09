const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const memoryjs = require('memoryjs');
const fs = require('fs');

const processName = "ffxiv_dx11.exe";
const BASE_OFFSET = 0x02A8C550;//动态内存地址，游戏更新失效先看这个

let win;
let updateInterval;
let gameHandle = null;
let modBaseAddr = null;

const CURRENT_VERSION = "0.0.5"; // 更新版本——打包前记得改这里

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
                        url: finalDownloadUrl, // 把筛选出来的单个最稳网址发给前端
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
    if (gameHandle) return true;
    try {
        const processObject = memoryjs.openProcess(processName);
        gameHandle = processObject.handle;
        modBaseAddr = processObject.modBaseAddr;
        console.log("成功连接游戏");
        return true;
    } catch (e) {
        return false;
    }
}

function readMemoryAndSync() {
    if (!win || win.isDestroyed()) return;
    if (!connectGame()) return;

    try {
        const processObject = memoryjs.openProcess(processName);
        const handle = processObject.handle;
        const modBaseAddr = processObject.modBaseAddr;

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
    }
}

//保存窗口位置
const configPath = path.join(__dirname, 'config.json');

function createWindow () {
  // 1. 准备默认的窗口配置
  let windowOptions = {
    width: 350,
    height: 450,
    resizable: false, //固定窗口大小
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true //不要动
    }
  };

  // 2. 尝试读取上一次保存的位置
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

  // 3. 用包含坐标的配置创建窗口
  win = new BrowserWindow(windowOptions);

  win.loadFile('index.html'); // 加载前端网页

  // 每 200 毫秒（0.2秒）读取一次内存并发给前端 (保留你原本的逻辑)
  updateInterval = setInterval(() => {
    readMemoryAndSync();
  }, 200);

  // 4. 【新增】在窗口即将关闭时，记录它当前在屏幕上的位置
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

  // 在窗口创建、加载完网页后，延迟 1.5 秒开始悄悄检查更新，避免影响软件秒开的速度
    setTimeout(() => {
        checkUpdateWithFallback();
    }, 1500);

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


ipcMain.on('write-memory', (event, data) => {
    console.log("后台收到前端传来的新数据:", data);

    try {
        const processObject = memoryjs.openProcess(processName);
        const handle = processObject.handle;
        const modBaseAddr = processObject.modBaseAddr;//获取动态基址

        let ptr = memoryjs.readMemory(handle, modBaseAddr + BASE_OFFSET, memoryjs.INT64);
        if (!ptr || ptr === 0 || ptr === 0n) {
            memoryjs.closeProcess(handle);
        }
        ptr = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x40n), memoryjs.INT64);
        if (!ptr || ptr === 0 || ptr === 0n) {
            console.log("\n请先在旋转模式下选中家具");
            memoryjs.closeProcess(handle);
        }
        ptr = memoryjs.readMemory(handle, Number(BigInt(ptr) + 0x18n), memoryjs.INT64);
        if (!ptr || ptr === 0 || ptr === 0n) {
            console.log("\n请先在旋转模式下选中家具");
            memoryjs.closeProcess(handle);
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

        console.log("\n新坐标:");
        console.log(`X（横）=${data.x} `);
        console.log(`Y（高）=${data.y} `);
        console.log(`Z（纵）=${data.z} `);
        console.log(` 角度 =${data.r} `);

        memoryjs.closeProcess(handle);

    } catch (error) {
        console.error("写入失败:", error.message);
    }

});

ipcMain.on("open-help", () => {
    const helpWindow = new BrowserWindow({
        width: 500,
        height: 510,
        resizable: false,
        autoHideMenuBar: true
    });

    helpWindow.loadFile("help.html");

});

ipcMain.on("set-always-on-top", (event, value) => {
    win.setAlwaysOnTop(value, 'screen-saver');
});

ipcMain.on('open-external-url', (event, url) => {
    shell.openExternal(url);
});

ipcMain.handle('get-background-path', () => {
  return path.join(process.resourcesPath, 'assets', 'Background.png');
});


