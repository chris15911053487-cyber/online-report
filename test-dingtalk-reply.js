const { getPool, sql } = require("/app/src/db");
const { agentChatCore } = require("/app/src/agent-chat-core");
const pino = require("pino");
const log = pino({ name: "test-reply" });

(async () => {
  const pool = await getPool();
  const senderStaffId = "0506206465685017";

  const rs = await pool.request()
    .input("dduid", sql.NVarChar(128), senderStaffId)
    .query("SELECT TOP (1) USER_CODE FROM dbo.OUSR WHERE U_DDUserId = @dduid");
  const userCode = rs.recordset && rs.recordset[0] && rs.recordset[0].USER_CODE;
  console.log("1. userCode:", userCode);

  const conversationId = "ding_test_reply_004";
  const result = await agentChatCore({
    userCode,
    displayName: userCode,
    conversationId,
    message: "Hi",
    log,
  });
  console.log("2. result status:", result.status);
  console.log("3. reply text length:", (result.message || "").length);

  const tokenRes = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appKey: process.env.DINGTALK_APP_KEY,
      appSecret: process.env.DINGTALK_APP_SECRET,
    }),
  });
  const tokenData = await tokenRes.json();
  console.log("4. token ok:", !!tokenData.accessToken);
  if (!tokenData.accessToken) {
    console.log("4b. token error:", JSON.stringify(tokenData));
  }

  if (tokenData.accessToken) {
    const sendRes = await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": tokenData.accessToken,
      },
      body: JSON.stringify({
        robotCode: process.env.DINGTALK_APP_KEY,
        userIds: [senderStaffId],
        msgKey: "sampleMarkdown",
        msgParam: JSON.stringify({ title: "AI", text: "debug test reply" }),
      }),
    });
    console.log("5. send status:", sendRes.status);
    const sendBody = await sendRes.text();
    console.log("6. send response:", sendBody);
  }

  process.exit(0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
