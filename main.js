const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");

let mainWindow;
let ffmpegProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile("index.html");
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// screen kaynaklarını al
ipcMain.handle("get-sources", async () => {
  const displays = screen.getAllDisplays();
  return displays.map((display) => ({
    id: display.id,
    name: `${display.label}`,
    display: {
      width: display.size.width,
      height: display.size.height,
      x: display.bounds.x,
      y: display.bounds.y,
    },
  }));
});

// record konumu seç
ipcMain.handle("select-output-path", async () => {
  const videosPath = app.getPath("videos");
  const outputFilePath = path.join(videosPath, "record.mp4");

  if (!fs.existsSync(videosPath)) {
    fs.mkdirSync(videosPath, { recursive: true });
  }

  return outputFilePath;
});

// ses cihazlarını listele
ipcMain.handle("get-audio-devices", async () => {
  try {
    // default cihazları al
    const { stdout: defaultDevices } = await execPromise(
      'pactl info | grep -e "Default Source:" -e "Default Sink:"'
    );
    const defaultSource = defaultDevices.split("\n")[0].split(":")[1].trim();
    const defaultSink = defaultDevices.split("\n")[1].split(":")[1].trim();

    // pulse cihazlarını listele
    const { stdout } = await execPromise(
      'pactl list sources | grep -e "Name:" -e "Description:"'
    );
    const devices = [];
    let currentDevice = null;

    stdout.split("\n").forEach((line) => {
      if (line.includes("Name:")) {
        const name = line.split(":")[1].trim();
        if (name.includes("monitor")) {
          currentDevice = {
            id: name,
            type: "system",
            isDefault: name === `${defaultSink}.monitor`,
          };
        } else {
          currentDevice = {
            id: name,
            type: "mic",
            isDefault: name === defaultSource,
          };
        }
      } else if (line.includes("Description:") && currentDevice) {
        currentDevice.name = line.split(":")[1].trim();
        devices.push(currentDevice);
        currentDevice = null;
      }
    });

    return devices;
  } catch (error) {
    console.error("Ses cihazları listelenirken hata:", error);
    return [];
  }
});

// kayıt başlat
ipcMain.on(
  "start-recording",
  async (
    event,
    {
      outputPath,
      sourceId,
      fps,
      width,
      height,
      crf,
      recordAudio,
      selectedAudioDevices,
    }
  ) => {
    const displays = screen.getAllDisplays();
    const selectedDisplay = displays.find((d) => d.id === parseInt(sourceId));

    if (!selectedDisplay) {
      console.error("Ekran bulunamadı");
      return;
    }

    // pulse default kaynaklarını al
    let defaultSink = null;
    let defaultSource = null;
    try {
      const { stdout: defaultDevices } = await execPromise(
        'pactl info | grep -e "Default Source:" -e "Default Sink:"'
      );
      defaultDevices.split("\n").forEach((line) => {
        if (line.includes("Default Sink:"))
          defaultSink = line.split(":")[1].trim();
        if (line.includes("Default Source:"))
          defaultSource = line.split(":")[1].trim();
      });
    } catch (e) {
      console.error("PulseAudio default kaynakları alınamadı:", e);
    }

    const ffmpegArgs = [
      "-f",
      "x11grab",
      "-video_size",
      `${selectedDisplay.size.width}x${selectedDisplay.size.height}`,
      "-framerate",
      fps.toString(),
      "-i",
      `${process.env.DISPLAY}+${selectedDisplay.bounds.x},${selectedDisplay.bounds.y}`,
    ];

    //  kayıt için gerekli parametreleri ekle
    if (
      recordAudio &&
      selectedAudioDevices &&
      selectedAudioDevices.length > 0
    ) {
      let inputIndex = 0;
      const audioInputs = [];
      const volumeFilters = [];
      selectedAudioDevices.forEach((device) => {
        inputIndex++;
        audioInputs.push(`[${inputIndex}:a]`);
        let vol = 1.0;
        if (typeof device.volume === "number") vol = device.volume / 100;
        if (device.type === "system") {
          const monitor = defaultSink ? `${defaultSink}.monitor` : "default";
          ffmpegArgs.push("-f", "pulse", "-i", monitor);
        } else if (device.type === "mic") {
          ffmpegArgs.push("-f", "pulse", "-i", defaultSource || "default");
        }
        volumeFilters.push(`[${inputIndex}:a]volume=${vol}[a${inputIndex}]`);
      });
      const amixInputs = selectedAudioDevices
        .map((_, i) => `[a${i + 1}]`)
        .join("");
      let filterComplex = "";
      if (volumeFilters.length > 0) {
        filterComplex =
          volumeFilters.join(";") +
          ";" +
          amixInputs +
          `amix=inputs=${selectedAudioDevices.length}:duration=longest[aout]`;
      }
      ffmpegArgs.push(
        "-filter_complex",
        filterComplex,
        "-map",
        "0:v",
        "-map",
        "[aout]",
        "-c:a",
        "aac",
        "-b:a",
        "192k"
      );
    }

    // codec ayarları
    ffmpegArgs.push(
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      crf.toString(),
      "-pix_fmt",
      "yuv420p"
    );

    if (
      width < selectedDisplay.size.width ||
      height < selectedDisplay.size.height
    ) {
      ffmpegArgs.push("-vf", `scale=${width}:${height}`);
    }

    ffmpegArgs.push(outputPath);

    console.log("FFmpeg komutu:", "ffmpeg", ffmpegArgs.join(" "));

    ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

    ffmpegProcess.stderr.on("data", (data) => {
      console.log("FFmpeg çıktısı:", data.toString());
    });

    ffmpegProcess.on("close", (code) => {
      console.log("FFmpeg işlemi sonlandı, çıkış kodu:", code);
      ffmpegProcess = null;
      mainWindow.webContents.send("recording-stopped");
    });
  }
);

// kayıt durdur
ipcMain.on("stop-recording", () => {
  if (ffmpegProcess) {
    ffmpegProcess.kill("SIGINT");
    ffmpegProcess = null;
  }
});
