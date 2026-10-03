/**
 * 释放本步骤创建的战斗子任务；超时/取消信号不等于工作已经停止。
 * 必须等已派发工作真正返回再释放CTS，清理错误不能替换原始业务失败。
 */
export async function retireScopedTask(handle, originalFailure = null) {
    if (!handle) return;
    handle.state.intentionalCancel = true;
    let cleanupFailure = null;
    try { handle.cts.Cancel(); } catch (error) { cleanupFailure = error; }
    if (originalFailure && !handle.state.settled) {
        log.warn("战斗子任务仍在退休，保留其资源并等待已派发工作返回；不启动后续输入");
    }
    try { await handle.task; } catch (error) { cleanupFailure ??= error; }
    try { handle.cts.Dispose(); } catch (error) { cleanupFailure ??= error; }
    if (!cleanupFailure) return;
    if (!originalFailure) throw cleanupFailure;
    log.warn("保留原始步骤失败，子任务清理另有异常: {error}", cleanupFailure.message || String(cleanupFailure));
}
