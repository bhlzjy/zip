/*
new Env('牛牛短剧微信小程序签到')
cron: 35 8 * * *
------------------------------------------
@Author: sm (独立单号版，支持sendNotify)
@Date: 2026-06-04
@Description: 牛牛短剧微信小程序签到（单账号，只依赖 wx_server_url）
环境变量：
  wx_server_url - wxcode 服务地址，例如 http://127.0.0.1:8088
------------------------------------------
所有缓存存放在: /ql/data/scripts/微信小程序/wxapp/
------------------------------------------
*/

const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ================== 可选通知模块 ==================
let sendNotify = null;
try {
    const notifyModule = require('./sendNotify');
    sendNotify = notifyModule.sendNotify || notifyModule;
    console.log("✅ 已加载 sendNotify 通知模块");
} catch (e) {
    console.log("⚠️ 未找到 sendNotify 模块，将跳过通知发送");
}

// ================== 独立日志 ==================
const LOG_NAME = "牛牛短剧微信小程序签到";
let startTime = Date.now();

function log(content) {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    console.log(`[${time}] ${content}`);
}

function done() {
    const cost = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`${LOG_NAME} 结束！🕛 ${cost}秒`);
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ================== 发送通知封装 ==================
async function sendNotification(title, content) {
    if (sendNotify) {
        try {
            await sendNotify(title, content);
            log(`通知已发送: ${title}`);
        } catch (e) {
            log(`发送通知失败: ${e.message || e}`);
        }
    } else {
        log(`通知未发送（无sendNotify模块）: ${title} - ${content}`);
    }
}

// ================== 缓存目录与工具 ==================
const CACHE_DIR = path.join(__dirname, "wxapp");
const TOKEN_CACHE_FILE = path.join(CACHE_DIR, "niuniuduanju_token.json");

function ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        log(`创建缓存目录: ${CACHE_DIR}`);
    }
}

function readTokenCache() {
    try {
        ensureCacheDir();
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8"));
        return data;
    } catch (e) {
        return null;
    }
}

function saveTokenCache(token, user, wxInfo) {
    try {
        ensureCacheDir();
        const cache = { token, user, wxInfo, updatedAt: new Date().toISOString() };
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2));
        log(`Token已保存到缓存`);
    } catch (e) {
        log(`保存token缓存失败: ${e.message || e}`);
    }
}

function clearTokenCache() {
    try {
        if (fs.existsSync(TOKEN_CACHE_FILE)) {
            fs.unlinkSync(TOKEN_CACHE_FILE);
            log(`已清除token缓存`);
        }
    } catch (e) {}
}

function maskToken(token = "") {
    if (!token) return "";
    return token.length > 14 ? `${token.slice(0, 8)}***${token.slice(-6)}` : `${token.slice(0, 4)}***`;
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function randomUserName() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let suffix = "";
    for (let i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
    return `用户${suffix}`;
}

function today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ================== 常量配置 ==================
const MINI_APP_ID = "wxcb95401f250e9a53";
const API_BASE = "https://api.tianjinzhitongdaohe.com/sqx_fast";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";
const DAILY_ACTION_COUNT = 2;
const EAT_GOLD_COUNT = 4;
const VIDEO_COUNT_STEPS = [1, 5, 9, 15, 20];
const VIDEO_DURATION_STEPS = [60, 300, 900, 1800, 3600, 7200, 9000];

// ================== 签到类（单账号） ==================
class NiuNiuTask {
    constructor() {
        this.token = "";
        this.user = {};
        this.wxInfo = {};
        this.pointsBefore = null;
        this.pointsAfter = null;
        this.signResult = null; // 'success', 'already', 'fail'
        this.signGainPoints = null;
        this.signFailReason = "";
    }

    async run() {
        // 随机延迟5-30s
        const delay = Math.floor(Math.random() * 25 + 5) * 1000;
        log(`随机延迟 ${(delay / 1000).toFixed(0)}s 后开始执行`);
        await wait(delay);

        // 1. 尝试从缓存加载token
        const cached = readTokenCache();
        if (cached?.token) {
            this.token = cached.token;
            this.user = cached.user || {};
            this.wxInfo = cached.wxInfo || {};
            log(`使用缓存token: ${maskToken(this.token)}`);
            if (await this.checkToken()) {
                log(`缓存token有效`);
            } else {
                log(`缓存token失效，重新登录`);
                clearTokenCache();
                this.token = "";
                this.user = {};
                this.wxInfo = {};
            }
        }

        // 2. 无有效token则登录
        if (!this.token) {
            await this.loginByWxCode();
        }
        if (!this.token) {
            log(`登录失败，脚本结束`);
            await sendNotification("牛牛短剧签到失败", "登录失败，请检查 wx_server_url 配置");
            return;
        }

        // 3. 查询积分并签到
        await this.getPoints("签到前");
        await this.getSignStatus();
        await this.signIn();
        await this.doDailyTasks();
        await this.getPoints("签到后");

        // 4. 发送签到通知
        await this.sendSignNotify();
    }

    async sendSignNotify() {
        let title = "";
        let content = "";
        const now = new Date().toLocaleString("zh-CN");

        if (this.signResult === "success") {
            title = "牛牛短剧签到成功";
            content = `签到时间: ${now}\n获得金币: ${this.signGainPoints ?? "?"}\n当前金币: ${this.pointsAfter ?? this.pointsBefore ?? "未知"}`;
        } else if (this.signResult === "already") {
            title = "牛牛短剧今日已签到";
            content = `签到时间: ${now}\n当前金币: ${this.pointsAfter ?? this.pointsBefore ?? "未知"}`;
        } else {
            title = "牛牛短剧签到失败";
            content = `签到时间: ${now}\n失败原因: ${this.signFailReason || "未知错误"}\n当前金币: ${this.pointsBefore ?? "未知"}`;
        }
        await sendNotification(title, content);
    }

    // ========== 获取微信code (只传appId, GET方式) ==========
    async getWxCode() {
        const wxServerUrl = process.env.wx_server_url;
        if (!wxServerUrl) throw new Error("未配置环境变量 wx_server_url");
        const baseUrl = wxServerUrl.replace(/\/+$/, '');
        const url = `${baseUrl}/login?appId=${MINI_APP_ID}`;
        log(`请求wxcode服务: ${url}`);
        const { status, data } = await axios.get(url, {
            timeout: 15000,
            validateStatus: () => true,
        });
        if (status !== 200) throw new Error(`wx_server 返回HTTP ${status}`);
        let code = data?.code;
        if (!code && data?.err === 0) code = data.code;
        if (!code) throw new Error(`wx_server 未返回code: ${JSON.stringify(data)}`);
        log(`获取code成功: ${code.slice(0, 10)}...`);
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getWxCode();
            // 步骤1: 微信登录
            const wxLogin = await this.request({
                apiPath: "/app/Login/wxLogin",
                params: { code },
                token: false,
            });
            const wxData = wxLogin.data || {};
            const openId = wxData.open_id || wxData.openId || "";
            const unionId = wxData.unionId || wxData.unionid || "";
            if (!openId || !unionId) throw new Error(`wxLogin 未返回openId/unionId: ${JSON.stringify(wxLogin)}`);
            this.wxInfo = wxData;

            // 步骤2: 插入或登录用户
            const login = await this.request({
                method: "POST",
                apiPath: "/app/Login/insertWxUser",
                token: false,
                json: true,
                data: {
                    openId,
                    unionId,
                    userName: randomUserName(),
                    avatar: "https://nnduanju.oss-cn-beijing.aliyuncs.com/01image/re-512.png",
                    sex: 1,
                    phone: "",
                    inviterCode: "",
                    qdCode: "",
                },
            });
            this.token = login.token || "";
            this.user = login.user || {};
            if (!this.token) throw new Error(`insertWxUser 未返回token: ${JSON.stringify(login)}`);
            saveTokenCache(this.token, this.user, this.wxInfo);
            log(`登录成功: ${this.user.userName || ""} ${maskPhone(this.user.phone)} token: ${maskToken(this.token)}`);
        } catch (e) {
            log(`登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            const result = await this.request({ apiPath: "/app/user/selectUserById" });
            this.user = result.data || this.user;
            return true;
        } catch (e) {
            return false;
        }
    }

    // ========== 通用请求方法 ==========
    getHeaders(extra = {}) {
        return {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/19/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "content-type": "application/x-www-form-urlencoded",
            ...(this.token ? { token: this.token } : {}),
            ...extra,
        };
    }

    async request({ method = "GET", apiPath, params = {}, data = {}, token = true, json = false }) {
        const options = {
            method,
            url: `${API_BASE}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`,
            headers: this.getHeaders(json ? { "content-type": "application/json" } : {}),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (!token) delete options.headers.token;
        if (method === "GET") options.params = params;
        else options.data = data;

        const { status, data: result } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${typeof result === "string" ? result.slice(0, 200) : JSON.stringify(result)}`);
        if (!result || result.code !== 0) {
            const err = new Error(result?.msg || result?.message || JSON.stringify(result));
            err.code = result?.code;
            throw err;
        }
        return result;
    }

    // ========== 积分相关 ==========
    async getPoints(label = "积分") {
        try {
            const result = await this.request({ apiPath: "/app/integral/selectByUserId" });
            const points = result.data?.integralNum ?? "未知";
            log(`${label}: ${points}`);
            if (label.includes("签到前")) this.pointsBefore = points;
            if (label.includes("签到后")) this.pointsAfter = points;
            return result.data;
        } catch (e) {
            log(`查询积分失败: ${e.message || e}`);
            return null;
        }
    }

    async getSignStatus() {
        try {
            const result = await this.request({
                apiPath: "/app/integral/selectIntegralDay",
                params: {
                    classify: 1,
                    userId: this.user.userId || "",
                },
            });
            const list = Array.isArray(result.data) ? result.data : [];
            const signedDays = list.filter((item) => item?.num).length;
            log(`本周签到记录: ${signedDays}/${list.length || 7}`);
            return list;
        } catch (e) {
            log(`查询签到记录失败: ${e.message || e}`);
            return [];
        }
    }

    async signIn() {
        try {
            const result = await this.request({
                apiPath: "/app/integral/signIn",
                params: { date: today() },
            });
            this.signResult = "success";
            this.signGainPoints = result.data?.integralNum || result.msg;
            log(`签到成功: ${result.msg || "success"}`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|已经签到|重复|今日.*签|不能重复|签到过/.test(message)) {
                this.signResult = "already";
                log(`今日已签到`);
                return;
            }
            this.signResult = "fail";
            this.signFailReason = message;
            log(`签到失败: ${message}`);
            if (e.code === 401 || /token|登录|验证失败/.test(message)) clearTokenCache();
        }
    }

    // ========== 每日任务 ==========
    async doDailyTasks() {
        await this.completeDramaTasks();
        await this.completeEatGoldTasks();
        await this.completeVideoCoinTasks();
        await this.completeVideoDurationTasks();
        const tasks = [
            { name: "开宝箱", apiPath: "/app/integral/userTimer" },
            { name: "推荐剧观看金币", apiPath: "/app/integral/userDataVideo", params: await this.getUserDataVideoParams() },
            { name: "每日点赞剧集", apiPath: "/app/integral/goodVideo" },
            { name: "收藏新剧", apiPath: "/app/integral/collectVideo" },
            { name: "分享新剧", apiPath: "/app/integral/shareVideo" },
        ];
        for (const task of tasks) {
            await this.claimDailyTask(task);
        }
    }

    async claimDailyTask(task) {
        try {
            const result = await this.request({ apiPath: task.apiPath, params: task.params || {} });
            log(`${task.name}: ${result.msg || "已领取"}${result.data !== undefined ? ` ${result.data}` : ""}`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已领取|已完成|今日.*完成|重复|不能重复|已经.*领取/.test(message)) {
                log(`${task.name}: 今日已完成`);
                return;
            }
            if (/未完成|请先|任务未达成|次数不足|时间未到|倒计时|稍后|观看/.test(message)) {
                log(`${task.name}: ${message}`);
                return;
            }
            log(`${task.name}失败: ${message}`);
            if (e.code === 401 || /token|登录|验证失败/.test(message)) clearTokenCache();
        }
    }

    async completeEatGoldTasks() {
        try {
            for (let num = 0; num < EAT_GOLD_COUNT; num++) {
                try {
                    const result = await this.request({
                        apiPath: "/app/integral/addEatGold",
                        params: { num },
                    });
                    log(`吃饭看剧补贴[${num + 1}/${EAT_GOLD_COUNT}]: ${result.msg || "success"}`);
                } catch (e) {
                    const message = String(e.message || e);
                    if (/已领取|已完成|今日.*完成|重复|不能重复|已经.*领取/.test(message)) {
                        log(`吃饭看剧补贴[${num + 1}/${EAT_GOLD_COUNT}]: 今日已完成`);
                        continue;
                    }
                    log(`吃饭看剧补贴[${num + 1}/${EAT_GOLD_COUNT}]: ${message}`);
                    if (e.code === 401 || /token|登录|验证失败/.test(message)) clearTokenCache();
                }
            }

            try {
                const result = await this.request({ apiPath: "/app/integral/eatGold" });
                log(`当前餐点补贴: ${result.msg || "success"}`);
            } catch (e) {
                const message = String(e.message || e);
                if (/已领取|已完成|今日.*完成|重复|不能重复|已经.*领取/.test(message)) {
                    log(`当前餐点补贴: 今日已完成`);
                } else {
                    log(`当前餐点补贴: ${message}`);
                }
            }
        } catch (e) {
            log(`吃饭看剧补贴失败: ${e.message || e}`);
        }
    }

    async completeVideoCoinTasks() {
        try {
            let userInfo = await this.getUserInfo();
            let nextStep = Number(userInfo.okLookVideoNum || 0) + 1;
            if (nextStep < 1) nextStep = 1;
            if (nextStep > VIDEO_COUNT_STEPS.length) {
                log(`看视频次数前置: 今日已完成`);
                return;
            }

            for (let step = nextStep; step <= VIDEO_COUNT_STEPS.length; step++) {
                await this.updateUserWatchCount(VIDEO_COUNT_STEPS[step - 1], step);
                try {
                    const result = await this.request({ apiPath: "/app/integral/lookVideoNum" });
                    log(`看视频次数金币[${step}/${VIDEO_COUNT_STEPS.length}]: ${result.msg || "success"}`);
                    userInfo = await this.getUserInfo();
                    if (Number(userInfo.okLookVideoNum || 0) >= VIDEO_COUNT_STEPS.length) break;
                } catch (e) {
                    const message = String(e.message || e);
                    if (/已领取|已完成|今日.*完成|重复|不能重复|已经.*领取/.test(message)) {
                        log(`看视频次数金币: 今日已完成`);
                        break;
                    }
                    log(`看视频次数金币[${step}/${VIDEO_COUNT_STEPS.length}]: ${message}`);
                    if (e.code === 401 || /token|登录|验证失败/.test(message)) clearTokenCache();
                    break;
                }
            }
        } catch (e) {
            log(`看视频次数前置失败: ${e.message || e}`);
        }
    }

    async completeVideoDurationTasks() {
        try {
            let userInfo = await this.getUserInfo();
            let nextStep = Number(userInfo.okLookVideoSec || 0);
            if (nextStep < 1) nextStep = 1;
            if (nextStep > VIDEO_DURATION_STEPS.length) {
                log(`看视频时长前置: 今日已完成`);
                return;
            }

            for (let step = nextStep; step <= VIDEO_DURATION_STEPS.length; step++) {
                await this.updateUserWatchDuration(VIDEO_DURATION_STEPS[step - 1], step);
                try {
                    const result = await this.request({ apiPath: "/app/integral/lookVideoSec" });
                    log(`看视频时长金币[${step}/${VIDEO_DURATION_STEPS.length}]: ${result.msg || "success"}`);
                    userInfo = await this.getUserInfo();
                    if (Number(userInfo.okLookVideoSec || 0) > VIDEO_DURATION_STEPS.length) break;
                } catch (e) {
                    const message = String(e.message || e);
                    if (/已领取|已完成|今日.*完成|重复|不能重复|已经.*领取/.test(message)) {
                        log(`看视频时长金币: 今日已完成`);
                        break;
                    }
                    log(`看视频时长金币[${step}/${VIDEO_DURATION_STEPS.length}]: ${message}`);
                    if (e.code === 401 || /token|登录|验证失败/.test(message)) clearTokenCache();
                    break;
                }
            }
        } catch (e) {
            log(`看视频时长前置失败: ${e.message || e}`);
        }
    }

    async updateUserWatchDuration(videoSec, lookVideoSec) {
        const userInfo = await this.getUserInfo();
        await this.request({
            method: "POST",
            apiPath: "/app/user/updateUsers",
            json: true,
            data: {
                userName: userInfo.userName || randomUserName(),
                avatar: userInfo.avatar || "https://nnduanju.oss-cn-beijing.aliyuncs.com/01image/re-512.png",
                phone: userInfo.phone || "",
                videoSec,
                lookVideoSec,
            },
        });
        log(`模拟观看时长: ${Math.floor(videoSec / 60)}分钟`);
    }

    async updateUserWatchCount(lookDayVideoNum, lookVideoNum) {
        const userInfo = await this.getUserInfo();
        await this.request({
            method: "POST",
            apiPath: "/app/user/updateUsers",
            json: true,
            data: {
                userName: userInfo.userName || randomUserName(),
                avatar: userInfo.avatar || "https://nnduanju.oss-cn-beijing.aliyuncs.com/01image/re-512.png",
                phone: userInfo.phone || "",
                lookDayVideoNum,
                lookVideoNum,
            },
        });
        log(`模拟观看视频次数: ${lookDayVideoNum}次`);
    }

    async getUserDataVideoParams() {
        try {
            const courses = await this.getDailyCourses();
            const course = courses[0] || {};
            if (!course.courseId) return {};
            const episode = await this.getCourseEpisode(course.courseId);
            return {
                courseId: course.courseId,
                courseDetailsId: episode?.courseDetailsId || course.courseDetailsId || "",
            };
        } catch (e) {
            return {};
        }
    }

    async completeDramaTasks() {
        try {
            const userInfo = await this.getUserInfo();
            const needGood = Number(userInfo.goodVideo || 0) < DAILY_ACTION_COUNT;
            const needCollect = Number(userInfo.collectVideo || 0) < DAILY_ACTION_COUNT;
            if (!needGood && !needCollect) return;

            const courses = await this.getDailyCourses();
            if (!courses.length) {
                log(`剧集任务前置: 未获取到推荐剧`);
                return;
            }

            let goodDone = 0;
            let collectDone = 0;
            for (const course of courses) {
                if (goodDone >= DAILY_ACTION_COUNT && collectDone >= DAILY_ACTION_COUNT) break;
                const episode = await this.getCourseEpisode(course.courseId);
                const courseDetailsId = episode?.courseDetailsId || course.courseDetailsId || "";
                if (!course.courseId || !courseDetailsId) continue;

                if (needGood && goodDone < DAILY_ACTION_COUNT) {
                    await this.setCourseCollect(course.courseId, courseDetailsId, 2, 0);
                    await this.setCourseCollect(course.courseId, courseDetailsId, 2, 1);
                    goodDone++;
                }

                if (needCollect && collectDone < DAILY_ACTION_COUNT) {
                    await this.setCourseCollect(course.courseId, courseDetailsId, 1, 0);
                    await this.setCourseCollect(course.courseId, courseDetailsId, 1, 1);
                    collectDone++;
                }
            }

            if (goodDone || collectDone) {
                log(`剧集任务前置: 点赞${goodDone}次 收藏${collectDone}次`);
            }
        } catch (e) {
            log(`剧集任务前置失败: ${e.message || e}`);
        }
    }

    async getUserInfo() {
        const result = await this.request({ apiPath: "/app/user/selectUserById" });
        this.user = result.data || this.user;
        return this.user;
    }

    async getDailyCourses() {
        const result = await this.request({ apiPath: "/app/common/type/922" });
        const list = result.data?.courseList;
        return Array.isArray(list) ? list : [];
    }

    async getCourseEpisode(courseId) {
        const result = await this.request({
            apiPath: "/app/course/selectCourseDetailsByCourseId",
            params: {
                id: courseId,
                token: this.token,
            },
        });
        return result.data || {};
    }

    async setCourseCollect(courseId, courseDetailsId, classify, type) {
        await this.request({
            method: "POST",
            apiPath: "/app/courseCollect/insertCourseCollect",
            json: true,
            data: {
                courseId,
                courseDetailsId,
                classify,
                type,
            },
        });
    }
}

// ================== 主入口 ==================
(async () => {
    log(`${LOG_NAME} 开始！`);
    if (!process.env.wx_server_url) {
        log("❌ 未配置环境变量 wx_server_url，请设置后运行");
        await sendNotification("牛牛短剧配置错误", "未设置 wx_server_url 环境变量");
        done();
        return;
    }
    const task = new NiuNiuTask();
    await task.run();
    done();
})().catch(async e => {
    console.error(e);
    if (sendNotify) await sendNotification("牛牛短剧异常", `脚本运行异常: ${e.message || e}`);
    done();
});