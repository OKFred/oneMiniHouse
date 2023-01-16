import Taro from "@tarojs/taro";

const fs = Taro.getFileSystemManager();
let main = (() => {
    let filePath = Taro.env.USER_DATA_PATH;
    let writeLog = ({ fileName, data } = {}) => {
        let today = new Date().Format("yyyy-MM-dd");
        let now = new Date().toLocaleTimeString();
        let result = now + "\t" + (typeof data === "object" ? JSON.stringify(data) : data) + "\n";
        let status;
        try {
            fs.writeFileSync(filePath + "/" + fileName + today + `.txt`, result, "utf8");
            status = true;
        } catch (e) {
            console.error("文件写入失败", e);
            status = false;
        }
    }; //读写权限
    let readLog = ({ fileName, date } = {}) => {
        let result;
        try {
            result = fs.readFileSync(filePath + "/" + fileName + date + `.txt`, "utf8");
        } catch (e) {
            console.error("文件读取失败", e);
        }
        return result;
    }; //读写权限
    return { writeLog, readLog };
})();

export default main;
