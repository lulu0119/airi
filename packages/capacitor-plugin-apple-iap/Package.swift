// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ProjAiriCapacitorPluginAppleIap",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "ProjAiriCapacitorPluginAppleIap",
            targets: ["AppleIapPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "AppleIapPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/AppleIapPlugin"),
        .testTarget(
            name: "AppleIapPluginTests",
            dependencies: ["AppleIapPlugin"],
            path: "ios/Tests/AppleIapPluginTests")
    ]
)
