# Dong goi Windows, license va update

## 1. Kien truc

- Ban VPS/web van chay nhu cu: `npm start`. License khong bi bat neu khong co `LICENSE_ENFORCE=1`.
- Ban Windows dung Electron de mo web app noi bo tren `127.0.0.1`.
- Du lieu khach hang duoc luu trong thu muc userData cua Windows, khong ghi de vao thu muc cai dat.
- Khi chua kich hoat license, app chan cac API nghiep vu va hien man hinh nhap ma license.

## 2. Cau hinh truoc khi build

Mac dinh ban desktop da tro ve VPS hien tai:

```text
License API: https://ai.hc-agency.online/license-api
Update feed: https://ai.hc-agency.online/downloads/zalo-agent/
```

Neu dung domain khac, sua `/desktop/config.js` hoac set bien moi truong truoc khi build:

```bash
export LICENSE_SERVER_URL="https://domain-cua-ban/license-api"
export UPDATE_CHECK_URL="https://domain-cua-ban/license-api/api/updates/check"
export UPDATE_FEED_URL="https://domain-cua-ban/downloads/zalo-agent/"
```

Khong bat buoc co file CLI rieng. Ban desktop mac dinh dong goi truc tiep source
Node/Electron hien tai.

Chi dat them file Windows CLI neu sau nay tach rieng tool `zalo-agent` cho cac
API cu:

```text
/bin/zalo-agent.exe
```

## 3. Build file cai dat Windows

Source hien tai la app chinh. Khong can tao `bin/zalo-agent.exe` de app desktop
chay local. File do chi danh cho CLI cu neu sau nay tach rieng.

Vi app dung native module `better-sqlite3`, nen file cai Windows can build tren
Windows. Build truc tiep tu macOS/Linux se dung o buoc rebuild native module.

### Cach A: GitHub Actions Windows

```bash
git tag v1.0.0
git push origin v1.0.0
```

Hoac vao tab Actions, chay workflow `Build Windows Installer` bang
`workflow_dispatch`. Artifact tra ve gom:

```text
HC-Zalo-Agent-1.0.0-Setup.exe
latest.yml
*.blockmap
```

### Cach B: Build tren may Windows

```bash
npm ci
npm run check
npm run build:win
```

File cai dat se nam trong `/release`, dang:

```text
HC-Zalo-Agent-1.0.0-Setup.exe
```

Lenh `npm run build:win` se kiem tra truoc cac cau hinh quan trong. Neu chua co
`/bin/zalo-agent.exe`, lenh build chi canh bao va van tiep tuc.

## 4. Chay license server tren VPS

Tren VPS hien tai, license server nen chay bang PM2 sau Nginx:

```bash
export LICENSE_SERVER_SECRET="doi-chuoi-bi-mat-nay"
export LICENSE_SERVER_DB="/var/lib/zalo-agent-license/licenses.json"
export LICENSE_SERVER_BASE_PATH="/license-api"
export LICENSE_SERVER_PORT="5050"
npm run license-server
```

Public URL:

```text
https://ai.hc-agency.online/license-api/api/health
```

Tao ma license:

```bash
npm run license:create -- --customer "Cong ty ABC" --days 365 --seats 1
```

Gui ma hien ra cho khach. Moi `seats` la so may duoc kich hoat.

## 5. Update phan mem

Quy trinh update:

1. Tang version trong `/package.json`, vi du `1.0.1`.
2. Build lai: `npm run build:win`.
3. Upload file setup moi va `latest.yml` len:

```text
/opt/zalo-agent-web/public/downloads/zalo-agent/
```

4. Cap nhat bien moi truong cua license server:

```bash
export UPDATE_LATEST_VERSION="1.0.1"
export UPDATE_DOWNLOAD_URL="https://ai.hc-agency.online/downloads/zalo-agent/HC-Zalo-Agent-1.0.1-Setup.exe"
export UPDATE_NOTES="Sua loi va cai thien on dinh"
```

5. Restart license server:

```bash
pm2 restart zalo-license
```

Trong app, menu `Ung dung -> Kiem tra cap nhat` se goi electron-updater. Man hinh kich hoat license cung co dong thong bao neu endpoint update bao co ban moi.
