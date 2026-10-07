const examples = {
    electricity: [{ id: "01", name: "示例电表" }],
    tempHumidity: [{ id: "01", name: "示例温湿度传感器" }],
    sound: [{ id: "01", name: "示例声音传感器" }],
    light: [{ id: "01", name: "示例光照传感器" }],
    mix: [{ id: "01", name: "示例综合传感器" }],
};

// Optional local build configuration. Device IDs and labels are visible to app users.
const configured = import.meta.env.VITE_MODBUS_DEVICES_JSON
    ? JSON.parse(import.meta.env.VITE_MODBUS_DEVICES_JSON)
    : {};

for (const [kind, devices] of Object.entries(configured)) {
    if (!(kind in examples) || !Array.isArray(devices) || devices.some((device) =>
        !device || !/^[0-9a-f]{2}$/i.test(device.id) || parseInt(device.id, 16) < 1 ||
        parseInt(device.id, 16) > 247 || typeof device.name !== "string" || !device.name.trim())) {
        throw new Error(`Invalid VITE_MODBUS_DEVICES_JSON entry: ${kind}`);
    }
}

export function deviceOptions(kind) {
    return [{ tag: "users", list: configured[kind] || examples[kind] || [] }];
}
