// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../C2CTypes.sol";

/**
 * @title TLSNParserLib
 * @notice Shared JSON parsing helpers for TLSN platform verifier contracts.
 *         All functions are `internal pure/view` so they get inlined into each
 *         platform verifier at compile time — no external call overhead and each
 *         verifier remains a self-contained deployment.
 */
library TLSNParserLib {
    uint256 internal constant FIAT_PRECISION_X1000 = 1000;

    // ================================================================
    //                      Key-hash helpers
    // ================================================================

    /**
     * @notice Extract the keccak256 hash of the JSON key from a `"key":value` byte slice.
     * @dev Caller must ensure val[0] == '"'.
     * @return keyHash  hash of the key string; bytes32(0) on parse failure
     */
    function parseKeyHash(bytes memory val) internal pure returns (bytes32 keyHash) {
        for (uint256 i = 1; i < val.length; i++) {
            if (val[i] == '"') {
                uint256 len = i - 1;
                if (len == 0) return bytes32(0);
                assembly {
                    keyHash := keccak256(add(val, 33), len)
                }
                return keyHash;
            }
        }
        return bytes32(0);
    }

    // ================================================================
    //                  String / numeric extractors
    // ================================================================

    /**
     * @notice Extract the string value from `"key":"stringValue"` format.
     */
    function extractStringValue(bytes memory val) internal pure returns (bytes memory) {
        uint256 valueStart;
        bool found;
        for (uint256 i = 1; i < val.length - 1; i++) {
            if (val[i] == ':' && val[i + 1] == '"') {
                valueStart = i + 2;
                found = true;
                break;
            }
        }
        if (!found) revert InvalidKeyValueFormat();

        for (uint256 i = valueStart; i < val.length; i++) {
            if (val[i] == '"') {
                uint256 len = i - valueStart;
                bytes memory result = new bytes(len);
                for (uint256 j = 0; j < len; j++) {
                    result[j] = val[valueStart + j];
                }
                return result;
            }
        }
        revert InvalidKeyValueFormat();
    }

    /**
     * @notice Extract a raw uint256 from `"key":123` or `"key":"123"` format.
     */
    function extractRawUint(bytes memory val) internal pure returns (uint256 result) {
        uint256 numStart;
        bool found;
        for (uint256 i = 1; i < val.length; i++) {
            if (val[i] == ':') {
                numStart = i + 1;
                found = true;
                break;
            }
        }
        if (!found) revert InvalidKeyValueFormat();

        if (numStart < val.length && val[numStart] == '"') numStart++;

        for (uint256 i = numStart; i < val.length; i++) {
            bytes1 c = val[i];
            if (c >= '0' && c <= '9') {
                result = result * 10 + uint256(uint8(c) - 48);
            } else {
                break;
            }
        }
    }

    /**
     * @notice Extract a fiat amount × 1000 from `"key":123.456` or `"key":"123.456"` format.
     * @dev Supports integer and decimal inputs; pads to 3 decimal places.
     *      e.g. 5 → 5000, 5.12 → 5120, "250.00" → 250000
     */
    function extractFiatAmount(bytes memory val) internal pure returns (uint256) {
        uint256 numStart;
        bool found;
        for (uint256 i = 1; i < val.length; i++) {
            if (val[i] == ':') {
                numStart = i + 1;
                found = true;
                break;
            }
        }
        if (!found) revert InvalidKeyValueFormat();

        if (numStart < val.length && val[numStart] == '"') numStart++;

        uint256 intPart;
        uint256 fracPart;
        uint256 fracDigits;
        bool hasDot;

        for (uint256 i = numStart; i < val.length; i++) {
            bytes1 c = val[i];
            if (c >= '0' && c <= '9') {
                if (hasDot) {
                    if (fracDigits < 3) {
                        fracPart = fracPart * 10 + uint256(uint8(c) - 48);
                        fracDigits++;
                    }
                } else {
                    intPart = intPart * 10 + uint256(uint8(c) - 48);
                }
            } else if (c == '.') {
                hasDot = true;
            } else {
                break;
            }
        }

        for (uint256 i = fracDigits; i < 3; i++) {
            fracPart = fracPart * 10;
        }

        return intPart * FIAT_PRECISION_X1000 + fracPart;
    }

    // ================================================================
    //            BokkyPooBah datetime → Unix timestamp
    // ================================================================

    /**
     * @notice Parse "YYYY-MM-DD HH:MM:SS" (UTC+8) → Unix UTC seconds.
     * @dev Uses the BokkyPooBahsDateTimeLibrary algorithm inline.
     *      Subtracts 28800 (8 * 3600) to convert from UTC+8 → UTC.
     * @param dateStr  e.g. "2026-03-31 23:34:44" as bytes
     * @return unix    Unix timestamp in UTC seconds
     */
    function parseDatetimeToUnix(bytes memory dateStr) internal pure returns (uint256 unix) {
        if (dateStr.length < 19) revert InvalidDatetimeFormat();

        uint256 year  = _p4(dateStr, 0);
        uint256 month = _p2(dateStr, 5);
        uint256 day   = _p2(dateStr, 8);
        uint256 hour  = _p2(dateStr, 11);
        uint256 minute = _p2(dateStr, 14);
        uint256 sec   = _p2(dateStr, 17);

        uint256 days_ = _daysFromDate(year, month, day);
        uint256 utc8 = days_ * 86400 + hour * 3600 + minute * 60 + sec;
        // Convert UTC+8 → UTC
        unix = utc8 - 28800;
    }

    // ── BokkyPooBah sub-helpers ──────────────────────────────────

    function _p2(bytes memory b, uint256 offset) private pure returns (uint256 v) {
        v = (uint256(uint8(b[offset])) - 48) * 10 + (uint256(uint8(b[offset + 1])) - 48);
    }

    function _p4(bytes memory b, uint256 offset) private pure returns (uint256 v) {
        v = (uint256(uint8(b[offset])) - 48) * 1000
          + (uint256(uint8(b[offset + 1])) - 48) * 100
          + (uint256(uint8(b[offset + 2])) - 48) * 10
          +  uint256(uint8(b[offset + 3])) - 48;
    }

    /**
     * @dev BokkyPooBahsDateTimeLibrary: days since Unix epoch for a calendar date.
     *      Reference: https://github.com/bokkypoobah/BokkyPooBahsDateTimeLibrary
     */
    function _daysFromDate(uint256 year, uint256 month, uint256 day) private pure returns (uint256 _days) {
        int256 _year  = int256(year);
        int256 _month = int256(month);
        int256 _day   = int256(day);

        int256 jd = _day
            - 32075
            + (1461 * (_year + 4800 + (_month - 14) / 12)) / 4
            + (367 * (_month - 2 - ((_month - 14) / 12) * 12)) / 12
            - (3 * ((_year + 4900 + (_month - 14) / 12) / 100)) / 4;

        // 2440588 = Julian Day of 1970-01-01
        _days = uint256(jd - 2440588);
    }
}
