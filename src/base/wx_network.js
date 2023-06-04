/**
 * @author Fred
 * @desc 小程序网络请求封装
 * @since 2023-02-28 10:48:00
 */

import FormData from "./formData.js"; //小程序暂不支持Form Data 需要polyFill

/**
 * @desc 发起网络请求
 * @param {object} queryObj - 请求对象
 * @param {string} url - 请求地址(可选)
 * @return {object} res - 响应对象
 * @example
 * let queryObj={request:{url:"https://example.com/list",header:{method:"GET",data:{currentPage:1}}},response:{data:{}},info:{}};
 * doFetch(queryObj).then((res)=>console.log(res));
 * */
async function doFetch(queryObj, url) {
    if (!url) url = queryObj.request.url;
    if (url === undefined) {
        queryObj.response.data = "url undefined";
        return queryObj;
    }
    if (
        queryObj.request.header.method === "GET" &&
        !/\?/.test(url) &&
        queryObj.request.data &&
        Object.keys(queryObj.request.data).length
    ) {
        url = url + "?" + objToParam(queryObj.request.data, url);
    }
    queryObj.request.url = url;
    queryObj = headerMaker(queryObj); //request header
    let header = queryObj.request.header;
    let fetching = await new Promise((resolve, reject) =>
        wx.request({
            method: header.method,
            url,
            data: header.body, //非GET下有数据
            header: header.headers ? header.headers : {},
            // timeout,
            // dataType,
            // responseType,
            enableHttp2: true,
            // enableQuic,
            // enableCache,
            // enableHttpDNS,
            // httpDNSServiceId,
            // enableChunked,
            // forceCellularNetwork,
            success: (res) => resolve(res),
            fail: (err) => resolve(err),
        }),
    );
    if (!fetching) return queryObj;
    let res = headerReceiver(queryObj, fetching); //response header
    return res;
}

/**
 * @desc 生成请求头
 * @param {object} queryObj - 请求对象
 * @return {object} queryObj - 请求对象
 * */
function headerMaker(queryObj) {
    let header = queryObj.request.header;
    if (!header.headers) header.headers = {};
    if (queryObj.request.cookieObj) {
        let cookie = "";
        for (let [cookieName, detailObj] of Object.entries(queryObj.request.cookieObj)) {
            cookie += cookieName + "=" + detailObj.value + "; ";
        } // 转化为 cookie 字符串， append
        cookie = cookie.replace(/; $/, "");
        if (!header.headers.cookie) header.headers.cookie = "";
        header.headers.cookie += cookie;
    }
    if (header.method === "GET") return queryObj;
    let contentType = header.headers["Content-Type"] || header.headers["content-type"];
    let body;
    if (/json/i.test(contentType)) {
        body = JSON.stringify(queryObj.request.data);
    } else if (/urlencoded/i.test(contentType)) {
        body = objToParam(queryObj.request.data);
    } else if (/form-data/gi.test(contentType)) {
        if (queryObj.request.data instanceof FormData) {
            body = queryObj.request.data;
        } else {
            body = new FormData();
            for (let [k, v] of Object.entries(queryObj.request.data)) {
                if (typeof v !== "object") {
                    body.append(k, v);
                } else {
                    body.append(k, JSON.stringify(v));
                }
                if (queryObj.request.fileArr && queryObj.request.fileArr.length) {
                    queryObj.request.fileArr.forEach((fileObj) => {
                        if (typeof fileObj === "object") {
                            let { url, blob, fileName, name } = fileObj;
                            body.appendFile(name, blob, url, fileName);
                        } //传参字段名，二进制数据，文件链接，文件名
                    });
                }
            } //🚩小程序文件上传
            let { contentType, buffer } = body.getData();
            header.headers["Content-Type"] = contentType;
            body = buffer;
        }
    }
    if (header.method === "POST") header.body = body;
    return queryObj;
}

/**
 * @desc 生成响应头
 * @param {object} res - 响应对象
 * @param {object} fetching - fetch响应对象
 * @return {object} res - 响应对象
 * */
function headerReceiver(res, msg) {
    let { data, cookies, errMsg, header, statusCode } = msg;
    let ok = statusCode >= 200 && statusCode < 400 ? true : false;
    res.response.headers = header;
    res.response.data = data;
    res.response.cookies = cookies;
    res.response.net = {
        status: statusCode,
        errMsg,
        ok,
    };
    if (res.response.headers && res.response.headers["set-cookie"]) res = cookieSetter(res); //node-fetch
    return res;
}

/**
 * @desc node-fetch 历史cookie读取并附在请求头(后端)
 * @env server
 * @param {object} queryObj - 请求对象
 * @return {object} queryObj - 请求对象
 * */
function cookieGetter(queryObj) {
    //小程序里暂时用不到，似乎
    // 读取所需的cookies，准备新的请求
    let allCookieObj = queryObj.response.allCookieObj;
    let cookieObj = queryObj.request.cookieObj ? queryObj.request.cookieObj : {};
    let found = false;
    let reqDomain = new URL(queryObj.request.url).host;
    let reqPath = new URL(queryObj.request.url).pathname;
    let { domainMain, domainSub } = domainChecker(reqDomain);
    if (allCookieObj[domainMain] === undefined) return queryObj;
    if (allCookieObj[domainMain][domainSub] === undefined) return queryObj;
    for (let [path, target] of Object.entries(allCookieObj[domainMain][domainSub])) {
        if (reqPath.match(path)) {
            found = true;
            Object.assign(cookieObj, target);
        }
    }
    if (!found) return queryObj;
    if (domainSub !== "www") {
        if (allCookieObj[domainMain]["www"] && allCookieObj[domainMain]["www"]["/"]) {
            Object.assign(cookieObj, allCookieObj[domainMain]["www"]["/"]);
        }
    }
    queryObj.request.cookieObj = cookieObj;
    return queryObj;
}

/**
 * @desc node-fetch 请求得到的set-cookie读取并存为对象(后端)
 * @env server
 * @param {object} res - 响应对象
 * @return {object} res - 响应对象
 * */
function cookieSetter(res) {
    // 请求完毕后，暂存得到的cookies
    let allCookieObj = res.response.allCookieObj || {}; // 读取现有 cookie or 重置
    let resCookie = res.response.headers["set-cookie"].split("\n");
    let resDomain = new URL(res.response.net.url).host;
    let cookieObj = {};
    resCookie.forEach((cookieString) => {
        let cookieInfo = cookieString.split(";");
        // extract cookie name, value, and extra data
        let cookieBody = cookieInfo[0].split("=");
        let [cookieName, ...valueArr] = cookieBody;
        let name = cookieName.trim();
        let value = valueArr.join("="); // 需要考虑值包含多个等号的情况
        cookieObj[name] = {};
        cookieObj[name].value = value;
        for (let i = 1; i < cookieInfo.length; i++) {
            let cookieBody = cookieInfo[i].split("=");
            let [name, ...valueArr] = cookieBody;
            name = name.trim();
            let value = valueArr.join("=");
            cookieObj[cookieName][name] = value;
        }
        // extract domain & sub-domain & path
        let domain = cookieInfo.find((str) => !!str.match(/Domain=/gi));
        domain = domain ? domain.replace(/Domain=(\.)?/gi, "").trim() : resDomain;
        let { domainMain, domainSub } = domainChecker(domain);
        let path = cookieInfo.find((str) => !!str.match(/Path=/gi));
        path = path
            ? path.replace(/.*Path=(.*)/gi, (match, p1) => {
                  if (p1 === "/") return p1;
                  return p1.replace(/\/$/, ""); // 去掉末尾的/
              })
            : "/";
        if (allCookieObj[domainMain] === undefined) allCookieObj[domainMain] = {};
        if (allCookieObj[domainMain][domainSub] === undefined) {
            allCookieObj[domainMain][domainSub] = {};
        }
        if (allCookieObj[domainMain][domainSub][path] === undefined) {
            allCookieObj[domainMain][domainSub][path] = {};
        }
        Object.assign(allCookieObj[domainMain][domainSub][path], cookieObj);
    });
    res.response.cookieObj = cookieObj;
    res.response.allCookieObj = allCookieObj;
    return res;
}

/**
 * @desc 提取域名信息
 * @param {string} domain - 域名
 * @return {object} domainInfo - 域名信息
 * @return {string} domainInfo.domainMain - 主域名
 * @return {string} domainInfo.domainSub - 子域名
 * @example
 * domainChecker("new.example.com") => { domainMain: "example.com", domainSub: "new" }
 * */
function domainChecker(domain) {
    // 判断域名归属
    let domainInfo = domain.split(".");
    let domainMain = domainInfo[domainInfo.length - 2] + "." + domainInfo[domainInfo.length - 1];
    domainInfo.pop();
    domainInfo.pop();
    let domainSub = domainInfo.join(".") || "www";
    return { domainMain, domainSub };
}

/**
 * @desc 对象转参数
 * @param {object} obj - 对象
 * @return {string} param - 参数
 * */
function objToParam(obj) {
    let arr = [];
    for (let [k, v] of Object.entries(obj)) {
        if (typeof v === "object") {
            arr.push(encodeURIComponent(k) + "=" + encodeURIComponent(JSON.stringify(v)));
        } else {
            if (v !== undefined) arr.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
        }
    }
    return arr.join("&");
}

/**
 * @desc URL转对象
 * @param {string} url - URL
 * @return {object} obj - 对象
 * */
function paramToObj(url) {
    let params = new URL(url).searchParams;
    let obj = {};
    for (let [k, v] of params.entries()) {
        obj[k] = v;
    }
    return obj;
}

/**
 * @desc 模拟异步请求
 * @param {number} milsec - 毫秒数
 * @return {Promise} - Promise对象
 * */
async function sleep(milsec) {
    return new Promise((resolve, reject) => {
        try {
            setTimeout(resolve, milsec);
        } catch (error) {
            console.log(error);
            return reject(null);
        }
    }).catch((e) => {
        console.log(e);
        return false;
    });
}

export default doFetch;
export { doFetch, objToParam, paramToObj, sleep };
