        // durable record AI Studio can't provide for Live API sessions.
        if (responseKeys.length > 0 && !(responseKeys.length === 1 && responseKeys[0] === "usageMetadata" && !response.serverContent)) {
          appendCallLog(callId, { type: "gemini_frame", keys: responseKeys, usageMetadata: response.usageMetadata || null, serverContent: response.serverContent || null, toolCall: response.toolCall || null });
        }
        // Diagnostic only (temporary) — transcript is coming back empty for
        // real Vobiz calls despite inputAudioTranscription/
        // outputAudioTranscription being requested in the session config.
        // The first sample landed on an empty keepalive {} — skip those and
        // only dump non-empty serverContent samples (capped at 5 total per
        // call) so we can see real shapes without spamming the log.
        if (response.serverContent && Object.keys(response.serverContent).length > 0 && loggedSampleServerContent < 5) {
          loggedSampleServerContent++;
          log.info(`🔎 Vobiz sample serverContent #${loggedSampleServerContent}:`, JSON.stringify(response.serverContent).slice(0, 1000));
        }
        if (response.toolCall) {
          log.info("🛠️ toolCall detected:", JSON.stringify(response.toolCall).slice(0, 500));
        }

        // ── PRIMARY: top-level toolCall (standard Gemini Live path)
        const topLevelCalls = response.toolCall?.functionCalls || [];

        // ── SECONDARY: functionCall parts inside modelTurn (alternate Live API path)
        const modelTurnParts = response.serverContent?.modelTurn?.parts || [];
        const embeddedCalls = modelTurnParts
          .filter(p => p.functionCall)
          .map(p => ({ id: p.functionCall.id || `fn_${Date.now()}`, name: p.functionCall.name, args: p.functionCall.args }));

        // A single provider event may expose the same logical call through
        // multiple envelopes. Deduplicate before executing any side effect.
        const allFunctionCalls = [];
        const seenCallsThisResponse = new Set();
        for (const call of [...topLevelCalls, ...embeddedCalls]) {
          const logicalKey = toolCallDeduper.key(call);
          if (seenCallsThisResponse.has(logicalKey)) {
            log.warn(`🛡️ Dropping duplicate tool call in one Gemini response: ${call.name}`);
            continue;
          }
          seenCallsThisResponse.add(logicalKey);
          if (!toolCallDeduper.claim(call)) {
            log.warn(`🛡️ Dropping replayed Gemini tool call: ${call.name}`);
            continue;
          }
          allFunctionCalls.push(call);
        }

        if (allFunctionCalls.length > 0) {
          const functionResponses = [];
          let questionnaireSavesThisMessage = 0;
          for (const call of allFunctionCalls) {
            if (endCallRequested && call.name !== "end_call") {
              functionResponses.push({
                id: call.id,