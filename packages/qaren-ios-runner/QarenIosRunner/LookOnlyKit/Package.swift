// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "LookOnlyKit",
  products: [.library(name: "LookOnlyKit", targets: ["LookOnlyKit"])],
  targets: [
    .target(name: "LookOnlyKit"),
    .testTarget(
      name: "LookOnlyKitTests",
      dependencies: ["LookOnlyKit"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
