const GET = "GET";
const POST = "POST";
// console.log("token----",  wx.getStorageSync("userInfoObj"))

const baseURL = "http://172.28.0.19:11022"; // 接口请求地址
export function request(options) {
    const { url, method, data, headerOptions } = options;
    return new Promise(function (resolve, reject) {
        let header = {
            "content-type": "application/json",
            // ...headerOptions
            Authorization:  wx.getStorageSync("userInfoObj").token||"",
        };
        wx.request({
            url: baseURL + url,
            method: method,
            data: method === POST ? JSON.stringify(data) : data,
            header: header,
            success(res) {
                console.log(res);
                // 请求到接口前页面展示loading
                wx.showLoading({
                    title: "加载中...",
                    success: function () {
                        // 请求成功
                        // 判断状态码，根据后端定义来判断
                        if (res.data.code == "200") {
                            resolve(res);
                        } else {
                            // 其他异常
                            reject("运行时错误,请稍后再试");
                            wx.showToast({
                                title: res.data.msg,
                                icon: "none",
                            });
                        }
                    },
                });
            },
            fail: function (err) {
                // 请求失败
                reject(err);
                wx.showToast({
                    title: "网络繁忙，请稍后重试~",
                    icon: "none",
                });
            },
            complete: function () {
                // 配对使用（loading消失）
                wx.hideLoading();
            },
        });
    });
}
