// 仅处理钓鱼结束后多人状态掉回单人的识别；不写CD。
export async function recoverSinglePlayerUid(uid) {
    if (!uid.includes("bgiMultiUser")) return { uid, changed: false };
    const singleImage = file.ReadImageMatSync("assets/single.png");
    let exitImage;
    try {
        const singleRo = RecognitionObject.TemplateMatch(singleImage);
        await genshin.returnMainUi();
        await sleep(200);
        const mainFrame = captureGameRegion();
        let single;
        try { single = mainFrame.Find(singleRo).isExist(); }
        finally { mainFrame.dispose(); }
        if (!single) return { uid, changed: false };

        exitImage = file.ReadImageMatSync("assets/Exit.png");
        const exitRo = RecognitionObject.TemplateMatch(exitImage);
        await sleep(800);
        keyPress("G");
        for (let attempt = 0; attempt < 20; attempt++) {
            const frame = captureGameRegion();
            let visible;
            try { visible = frame.Find(exitRo).isExist(); }
            finally { frame.dispose(); }
            if (visible) {
                const uidFrame = captureGameRegion();
                let confirmedUid;
                try { confirmedUid = String(uidFrame.Find(RecognitionObject.Ocr(1679, 1048, 200, 28)).text || "").replace(/\D/g, ""); }
                finally { uidFrame.dispose(); }
                if (!confirmedUid) throw new Error("[FISHING_MODE_UNCONFIRMED] 教程内未识别UID，不更新CD归属");
                return { uid: confirmedUid, changed: true };
            }
            if (attempt < 19) await sleep(500);
        }
        throw new Error("[FISHING_MODE_UNCONFIRMED] 多人转单人后未确认教程界面，不更新CD归属");
    } finally {
        exitImage?.dispose();
        singleImage.dispose();
    }
}
