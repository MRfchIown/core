import "jest-extended";

import { Slots } from "../../../../packages/crypto/src/crypto/slots";
import { configManager } from "../../../../packages/crypto/src/managers/config";
import { devnet } from "../../../../packages/crypto/src/networks";

describe("Slots", () => {
    beforeEach(() => configManager.setConfig(devnet));

    describe("getTime", () => {
        it("return epoch time as number", () => {
            const result = Slots.getTime(1490101210000);

            expect(result).toBeNumber();
            expect(result).toEqual(10);
        });
    });

    describe("getSlotNumber", () => {
        it("return slot number", () => {
            expect(Slots.getSlotNumber(10)).toBe(1);
        });
    });

    describe("getSlotTime", () => {
        it("returns slot time", () => {
            expect(Slots.getSlotTime(19614)).toBe(156912);
        });
    });

    describe("getNextSlot", () => {
        it("returns next slot", () => {
            expect(Slots.getNextSlot()).toBeNumber();
        });
    });

    describe("isForgingAllowed", () => {
        it("returns boolean", () => {
            expect(Slots.isForgingAllowed()).toBeDefined();
        });

        it("is true when over half the time in the block remains", () => {
            expect(Slots.isForgingAllowed(0)).toBeTrue();
            expect(Slots.isForgingAllowed(1)).toBeTrue();
            expect(Slots.isForgingAllowed(3)).toBeTrue();
            expect(Slots.isForgingAllowed(8)).toBeTrue();
            expect(Slots.isForgingAllowed(16)).toBeTrue();
        });

        it("is false when under half the time in the block remains", () => {
            expect(Slots.isForgingAllowed(4)).toBeFalse();
            expect(Slots.isForgingAllowed(5)).toBeFalse();
            expect(Slots.isForgingAllowed(6)).toBeFalse();
            expect(Slots.isForgingAllowed(7)).toBeFalse();
            expect(Slots.isForgingAllowed(15)).toBeFalse();
        });
    });

    describe("getTimeInMsUntilNextSlot", () => {
        it("should be ok", () => {
            const nextSlotTime = Slots.getSlotTime(Slots.getNextSlot());
            const now = Slots.getTime();

            expect(Slots.getTimeInMsUntilNextSlot()).toEqual((nextSlotTime - now) * 1000);
        });
    });

    describe("Dynamic block times", () => {
        it("should compute the total block time over several milestone changes", () => {
            // TODO:
        });

        it("should use the last known blocktime when no height is passed", () => {
            // use config.getHeight
        });
    });
});
