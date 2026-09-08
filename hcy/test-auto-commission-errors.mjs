import assert from "node:assert/strict";
import test from "node:test";
import { isCancellationError, rethrowIfCancellation } from "../repo/js/AutoCommissionNova/src/utils/error-utils.js";

test("real cancellation message from the host propagates", () => {
    const error = new Error("The operation was canceled.");
    assert.equal(isCancellationError(error), true);
    assert.throws(() => rethrowIfCancellation(error), candidate => candidate === error);
});

test("page timeout is a failure, not user cancellation", () => {
    assert.equal(isCancellationError(new Error("界面转换超时：return-main，实际=handbook=True")), false);
});

test("unfinished combat bypasses retry without being mislabeled as cancellation", () => {
    const error = new Error("[BGI_COMBAT_UNCONFIRMED] 战斗未结束");
    assert.equal(isCancellationError(error), false);
    assert.throws(() => rethrowIfCancellation(error), candidate => candidate === error);
});
