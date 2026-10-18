import AppKit

// 验收操作仅发生在这个临时窗口内，不打开用户文档。
let ownerPath = ProcessInfo.processInfo.environment["MAGPIE_CUA_TEST_OWNER"]
let logPath = ProcessInfo.processInfo.environment["MAGPIE_CUA_TEST_LOG"]
func record(_ kind: String, _ values: [String: Any] = [:]) {
    guard let logPath else { return }
    var item = values
    item["event"] = kind
    item["time"] = Date().timeIntervalSince1970
    guard let data = try? JSONSerialization.data(withJSONObject: item, options: [.sortedKeys]),
          let handle = FileHandle(forWritingAtPath: logPath) else { return }
    handle.seekToEndOfFile()
    handle.write(data)
    handle.write(Data([10]))
    try? handle.close()
}

final class Fixture: NSObject, NSApplicationDelegate, NSTextFieldDelegate, NSTextViewDelegate {
    var window: NSWindow!
    var clicks = 0
    let count = NSTextField(labelWithString: "Clicks: 0")
    let stepValue = NSTextField(labelWithString: "Step: 0")
    let sliderValue = NSTextField(labelWithString: "Slider: 20")
    let scrollView = NSScrollView()
    func label(_ text: String, _ frame: NSRect) -> NSTextField {
        let v = NSTextField(labelWithString: text)
        v.frame = frame
        window.contentView!.addSubview(v)
        return v
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        // 使用标准编辑菜单，使 Command+A 等组合键经过真实 AppKit 菜单分发。
        let menu = NSMenu()
        let appMenuItem = NSMenuItem(); menu.addItem(appMenuItem)
        let appMenu = NSMenu(); appMenu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); appMenuItem.submenu = appMenu
        let editItem = NSMenuItem(); menu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] { editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key) }
        editItem.submenu = editMenu; NSApp.mainMenu = menu
        if let ownerPath {
            Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
                if !FileManager.default.fileExists(atPath: ownerPath) { NSApp.terminate(nil) }
            }
        }
        window = NSWindow(contentRect: NSRect(x: 180, y: 100, width: 800, height: 620), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Magpie Computer Use Test"
        window.setAccessibilityIdentifier("magpie-cua-fixture-window")
        _ = label("Disposable Computer Use acceptance fixture", NSRect(x: 24, y: 566, width: 750, height: 28))
        _ = label("Editable field", NSRect(x: 24, y: 527, width: 140, height: 24))
        let field = NSTextField(string: "Ready")
        field.frame = NSRect(x: 170, y: 523, width: 450, height: 30)
        field.setAccessibilityIdentifier("fixture-input")
        field.setAccessibilityLabel("Test input")
        field.delegate = self
        field.target = self
        field.action = #selector(submitField(_:))
        window.contentView!.addSubview(field)
        let button = NSButton(title: "Increment click counter", target: self, action: #selector(clickCounter(_:)))
        button.frame = NSRect(x: 24, y: 470, width: 230, height: 34)
        button.setAccessibilityIdentifier("fixture-button")
        window.contentView!.addSubview(button)
        count.frame = NSRect(x: 270, y: 477, width: 140, height: 24)
        window.contentView!.addSubview(count)
        let stepper = NSStepper(frame: NSRect(x: 435, y: 465, width: 30, height: 42))
        stepper.minValue = 0; stepper.maxValue = 9; stepper.increment = 1; stepper.integerValue = 0
        stepper.setAccessibilityIdentifier("fixture-stepper")
        stepper.setAccessibilityLabel("Test stepper")
        stepper.target = self; stepper.action = #selector(step(_:))
        window.contentView!.addSubview(stepper)
        stepValue.frame = NSRect(x: 482, y: 477, width: 150, height: 24)
        window.contentView!.addSubview(stepValue)
        let slider = NSSlider(value: 20, minValue: 0, maxValue: 100, target: self, action: #selector(slide(_:)))
        slider.frame = NSRect(x: 170, y: 420, width: 450, height: 30)
        slider.isContinuous = true
        slider.setAccessibilityIdentifier("fixture-slider")
        slider.setAccessibilityLabel("Test slider")
        window.contentView!.addSubview(slider)
        sliderValue.frame = NSRect(x: 24, y: 423, width: 140, height: 24)
        window.contentView!.addSubview(sliderValue)
        scrollView.frame = NSRect(x: 24, y: 75, width: 752, height: 330)
        scrollView.hasVerticalScroller = true; scrollView.borderType = .bezelBorder
        scrollView.setAccessibilityLabel("Test scroll area")
        let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: 730, height: 2400))
        textView.minSize = NSSize(width: 0, height: 2400)
        textView.maxSize = NSSize(width: 730, height: 10000)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.font = NSFont.monospacedSystemFont(ofSize: 16, weight: .regular)
        textView.string = "Selection target: alpha beta gamma.\n" + (1...100).map { "Fixture row \($0): isolated test content." }.joined(separator: "\n")
        textView.setAccessibilityIdentifier("fixture-text")
        textView.setAccessibilityLabel("Test selection text")
        textView.delegate = self
        scrollView.documentView = textView
        scrollView.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled(_:)), name: NSView.boundsDidChangeNotification, object: scrollView.contentView)
        window.contentView!.addSubview(scrollView)
        _ = label("Only this fixture may be controlled. Close it after acceptance testing.", NSRect(x: 24, y: 27, width: 750, height: 28))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        record("ready", ["pid": ProcessInfo.processInfo.processIdentifier])
    }
    @objc func clickCounter(_ sender: NSButton) { clicks += 1; count.stringValue = "Clicks: \(clicks)"; record("click", ["count": clicks]) }
    @objc func step(_ sender: NSStepper) { stepValue.stringValue = "Step: \(sender.integerValue)"; record("step", ["value": sender.integerValue]) }
    @objc func slide(_ sender: NSSlider) { sliderValue.stringValue = "Slider: \(sender.integerValue)"; record("slider", ["value": sender.integerValue]) }
    @objc func submitField(_ sender: NSTextField) { record("return", ["value": sender.stringValue]) }
    @objc func scrolled(_ notification: Notification) { record("scroll", ["y": scrollView.contentView.bounds.origin.y]) }
    func controlTextDidChange(_ notification: Notification) { if let field = notification.object as? NSTextField { record("input", ["value": field.stringValue]) } }
    func textViewDidChangeSelection(_ notification: Notification) { if let view = notification.object as? NSTextView { let range = view.selectedRange(); record("selection", ["location": range.location, "length": range.length]) } }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let delegate = Fixture()
let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
