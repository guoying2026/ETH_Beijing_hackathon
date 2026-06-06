// Test for verifier range mapping logic.
//
// Validates that byte ranges calculated on a plaintext transcript correctly
// survive the TLSNotary redaction process: revealed ranges must preserve their
// original bytes, while redacted ranges must be replaced with the unrevealed
// marker (0x00 in TLSNotary; 0xFF is used below where the test sets its own
// marker convention).

#[cfg(test)]
mod tests {
    use std::str;

    /// Verifies that a range mapping over a partially-redacted transcript:
    ///  (a) still reads the correct bytes for a range that was NOT redacted, and
    ///  (b) returns the redaction marker for a range that WAS redacted.
    ///
    /// Previously this test used `let revealed = plaintext.to_vec()` (an
    /// identity copy), making the assertion trivially true.  The fix uses an
    /// actual redaction so the two assertions are non-trivially distinct.
    #[test]
    fn test_range_mapping_with_redacted_bytes() {
        // Simulate a plaintext HTTP response
        let plaintext = b"HTTP/1.1 200 OK\r\nDate: Wed, 29 Oct 2025 14:38:42 GMT\r\nContent-Type: application/json\r\n\r\n{\"screen_name\":\"test_user\"}";

        println!("Plaintext length: {}", plaintext.len());
        println!("Plaintext: {}", String::from_utf8_lossy(plaintext));

        // The Date header value is at bytes 23..52
        // (17 bytes status line + 6 bytes "Date: " = 23; "Wed...GMT" = 29 bytes)
        let date_header_start = 17usize;
        let date_header_end = 51usize;
        let date_header_bytes = &plaintext[date_header_start..date_header_end];
        println!(
            "\nDate header bytes [{}..{}]: {}",
            date_header_start,
            date_header_end,
            String::from_utf8_lossy(date_header_bytes)
        );

        // Simulate TLSNotary redaction: replace the Content-Type header with 0xFF markers.
        // This is the range that is NOT revealed; bytes 52..85 in the original transcript.
        let content_type_start = 52usize;
        let content_type_end = 85usize;
        let mut revealed = plaintext.to_vec();
        for i in content_type_start..content_type_end {
            revealed[i] = 0xFF; // 0xFF is the redaction marker used in this test
        }

        println!("\nRevealed length: {}", revealed.len());

        // (a) Non-redacted range: Date header must still match the original plaintext.
        let mapped_date = &revealed[date_header_start..date_header_end];
        println!(
            "\nMapped Date header in revealed: {}",
            String::from_utf8_lossy(mapped_date)
        );
        assert_eq!(
            date_header_bytes,
            mapped_date,
            "Date header (not redacted) must match original plaintext bytes"
        );

        // (b) Redacted range: Content-Type header must contain only the 0xFF marker,
        //     NOT the original plaintext bytes.
        let ct_in_plaintext = &plaintext[content_type_start..content_type_end];
        let ct_in_revealed = &revealed[content_type_start..content_type_end];
        assert!(
            ct_in_revealed.iter().all(|&b| b == 0xFF),
            "Redacted Content-Type range must contain only 0xFF markers"
        );
        assert_ne!(
            ct_in_plaintext,
            ct_in_revealed,
            "Redacted range must differ from the original plaintext"
        );
    }

    #[test]
    fn test_string_vs_byte_indices() {
        // Test that string indices don't match byte indices with multi-byte UTF-8
        let text_with_emoji = "Hello 🙈 World";
        let bytes = text_with_emoji.as_bytes();

        println!("Text: {}", text_with_emoji);
        println!("String length (chars): {}", text_with_emoji.chars().count());
        println!("Byte length: {}", bytes.len());

        // The emoji 🙈 is 4 bytes in UTF-8
        // So "Hello " is 6 bytes, then 🙈 is 4 bytes, then " World" is 6 bytes
        assert_eq!(bytes.len(), 16); // 6 + 4 + 6 = 16 bytes

        // Demonstrate the difference between string char boundaries and byte offsets
        // "Hello " is at bytes 0..6
        // 🙈 is at bytes 6..10
        // " World" is at bytes 10..16

        // Correct char boundary slicing (after emoji)
        let after_emoji = &text_with_emoji[10..]; // " World" - starts at char boundary
        println!("After emoji (char boundary [10..]): {}", after_emoji);
        assert_eq!(after_emoji, " World");

        // Byte slicing at position 7 would be INSIDE the emoji (6..10)
        // We can slice bytes but can't convert to valid UTF-8
        let byte_range = &bytes[7..12];
        println!("Byte range [7..12] (inside emoji): {:?}", byte_range);

        // This byte range contains partial UTF-8 and can't be decoded
        let invalid_utf8 = str::from_utf8(byte_range);
        assert!(invalid_utf8.is_err(), "Byte range inside emoji is invalid UTF-8");
    }

    /// Verifies that byte ranges derived from a plaintext transcript remain
    /// meaningful after simulated TLSNotary redaction.
    ///
    /// The previous version used `let revealed = plaintext_response.to_vec()`,
    /// making the assertion trivially `x == x`.  The fix introduces a real
    /// redaction (Content-Length header → \0 bytes) so that both assertions
    /// check distinct conditions:
    ///  - The Date range (revealed) still maps correctly.
    ///  - The Content-Length range (redacted) does NOT match the original.
    #[test]
    fn test_verifier_mapping_logic() {
        let plaintext_response = b"HTTP/1.1 200 OK\r\nDate: Wed, 29 Oct 2025 14:38:42 GMT\r\nContent-Length: 30\r\n\r\n{\"screen_name\":\"test_user\"}";

        // Byte layout:
        //  0..17  : "HTTP/1.1 200 OK\r\n"
        // 17..23  : "Date: "
        // 23..52  : "Wed, 29 Oct 2025 14:38:42 GMT"
        // 52..54  : "\r\n"
        // 54..72  : "Content-Length: 30"
        // 72..74  : "\r\n"
        // 74..76  : "\r\n"  (blank line)
        // 76..102 : "{\"screen_name\":\"test_user\"}"
        let date_value_start = 23usize;
        let date_value_end = 52usize;

        // Redact the Content-Length header value (bytes 54..74) with TLSNotary's
        // unrevealed marker (\0), producing a `revealed` that differs from `plaintext`.
        let content_length_start = 54usize;
        let content_length_end = 74usize;
        let mut revealed = plaintext_response.to_vec();
        for i in content_length_start..content_length_end {
            revealed[i] = 0x00; // TLSNotary uses \0 for unrevealed bytes
        }

        println!("Plaintext: {}", String::from_utf8_lossy(plaintext_response));
        println!(
            "Date value range [{}..{}]: {}",
            date_value_start,
            date_value_end,
            String::from_utf8_lossy(&plaintext_response[date_value_start..date_value_end])
        );

        // Assertion A: The Date range was not redacted — it should map identically.
        let mapped_date_value = &revealed[date_value_start..date_value_end];
        println!("Mapped date value: {}", String::from_utf8_lossy(mapped_date_value));
        assert_eq!(
            &plaintext_response[date_value_start..date_value_end],
            mapped_date_value,
            "Revealed Date range must match plaintext byte-for-byte"
        );

        // Assertion B: The Content-Length range was redacted — it must contain only \0.
        let cl_in_revealed = &revealed[content_length_start..content_length_end];
        assert!(
            cl_in_revealed.iter().all(|&b| b == 0x00),
            "Redacted Content-Length range must contain only \\0 unrevealed markers"
        );
        assert_ne!(
            &plaintext_response[content_length_start..content_length_end],
            cl_in_revealed,
            "Redacted range must differ from the original plaintext"
        );
    }

    /// Demonstrates the bug where extracting from a redacted string (with \0 →
    /// 🙈 substitution) gives wrong results due to multi-byte emoji offset shifts.
    ///
    /// The `if` guard that previously wrapped the counter-example assertions has
    /// been replaced with an explicit invariant `assert!`, ensuring the branch is
    /// always executed and can never be silently skipped.
    #[test]
    fn test_extract_from_raw_bytes_vs_redacted_string() {
        let response = b"HTTP/1.1 200 OK\r\nDate: Wed, 29 Oct 2025 14:38:42 GMT\r\nContent-Type: application/json\r\n\r\n{\"screen_name\":\"test_user\"}";

        // Simulate TLSNotary transcript with unrevealed bytes marked as \0
        let mut transcript_with_redacted = response.to_vec();

        // Redact Content-Type header (replace with \0)
        let content_type_start = 52;
        let content_type_end = 85;
        for i in content_type_start..content_type_end {
            transcript_with_redacted[i] = 0x00; // TLSNotary uses \0 for unrevealed
        }

        // Calculate range for screen_name value in JSON body
        // Body starts after "\r\n\r\n" at position 88
        // {"screen_name":"test_user"}
        //                ^^^^^^^^^^^
        let screen_name_start = 104usize; // Position of "test_user" (88 + 16)
        let screen_name_end = 113usize;   // End of "test_user" (104 + 9)

        // CORRECT APPROACH: Extract from raw bytes (positions unchanged)
        let correct_value = &transcript_with_redacted[screen_name_start..screen_name_end];
        let correct_string = String::from_utf8_lossy(correct_value);
        println!("✅ Correct (from raw bytes): {}", correct_string);
        assert_eq!(correct_string, "test_user", "Should extract correct value from raw bytes");

        // WRONG APPROACH: Convert to a display string that replaces \0 with 🙈
        // (common in debugging/logging code).
        // 🙈 is 4 bytes but \0 was 1 byte, so every redacted byte shifts subsequent
        // offsets by +3.  With 33 redacted bytes the string grows by 99 bytes.
        let redacted_string = String::from_utf8_lossy(&transcript_with_redacted)
            .replace('\0', "🙈");
        let wrong_bytes = redacted_string.as_bytes();

        // Invariant: the expanded string MUST be longer than the original indices.
        // 33 null bytes × 3 extra bytes per emoji = +99 bytes over the original.
        // Asserting this prevents the counter-example below from being silently skipped.
        assert!(
            screen_name_end <= wrong_bytes.len(),
            "test invariant: redacted string (len={}) must be longer than original end index ({}) \
             due to \\0→🙈 expansion (+3 bytes per null byte)",
            wrong_bytes.len(),
            screen_name_end
        );

        // Using the same byte offsets on the expanded string now points into the
        // middle of emoji sequences — yielding garbled output.
        let wrong_value = &wrong_bytes[screen_name_start..screen_name_end];
        let wrong_string = String::from_utf8_lossy(wrong_value);
        println!("❌ Wrong (from redacted string): {}", wrong_string);

        assert_ne!(
            wrong_string,
            "test_user",
            "Extracting from the \0→🙈-substituted string must NOT yield the original value"
        );
        assert!(
            wrong_string.contains("🙈") || wrong_string.chars().any(|c| c == '\u{FFFD}'),
            "Garbled extraction must contain redaction emojis or UTF-8 replacement characters"
        );

        println!("\n📝 Summary:");
        println!("   - Raw bytes approach: Correct value extraction");
        println!("   - Redacted string approach: Wrong due to multi-byte emoji shifting offsets");
        println!("   - Fix: Always extract ranges from raw transcript bytes BEFORE string conversion");
    }
}
