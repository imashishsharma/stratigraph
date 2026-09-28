# stratigraph benchmark scorecard

Generated 2026-09-28T04:21:35.561Z. Ground truth is labelled without stratigraph (ADR-0035).

## Targets

| Metric | Target | Value | |
| --- | --- | --- | --- |
| Non-source files in the hotspot top 20 | 0 | 0 | pass |
| Hotspot top-10 overlap with the labelled list | ≥ 60% | 92/138 (66%) | pass |
| Entity recall | ≥ 90% | 146/146 (100%) | pass |
| Table recall | ≥ 90% | 274/274 (100%) | pass |
| Endpoint recall | ≥ 95% | 519/520 (99%) | pass |
| Injection edges resolved | ≥ 85% | 215/226 (95%) | pass |
| Labelled deployables found as containers | ≥ 100% | 67/67 (100%) | pass |
| Containers that are deployables | ≥ 100% | 67/67 (100%) | pass |
| File roles matching the labels | ≥ 95% | 535/557 (96%) | pass |
| Views rendered without a coverage statement | 0 | 0 | pass |
| Repositories the pipeline completed on | 20/20 | 20/20 | pass |

## Per repository

| Repo | s | Extractors | Arch cov. | Non-src top20 | Hotspot top10 | Entities | Tables | Endpoints | Injections | Containers (R/P) | Roles | No coverage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| spring-petclinic | 3 | migrations ok 3/3; java ok 30/30 | 100% | 0 | 10/10 | 6/6 | 7/7 | 17/17 | 6/6 | 1/1 / 1/1 | 32/32 | 0 |
| jhipster-sample-app | 6 | migrations ok 7/7; java ok 80/80; typescript ok 185/185 | 100% | 0 | – | 5/5 | 8/8 | 38/38 | 13/13 | 2/2 / 2/2 | 31/31 | 0 |
| eladmin | 4 | migrations ok 2/2; java ok 269/269 | 100% | 0 | 7/10 | 21/21 | 37/37 | 100/100 | 10/10 | 1/1 / 1/1 | 18/18 | 0 |
| dubbo | 34 | java ok 2466/2466 | 100% | 0 | 5/10 | – | – | – | 10/10 | 6/6 / 6/6 | 25/25 | 0 |
| bitwarden-clients | 66 | typescript ok 5014/5014 | 100% | 0 | 6/10 | – | – | 17/17 | 10/10 | 5/5 / 5/5 | 25/27 | 0 |
| spring-framework-petclinic | 2 | migrations ok 4/4; java ok 47/47 | 100% | 0 | 9/10 | 6/6 | 7/7 | 18/18 | 11/11 | 1/1 / 1/1 | 31/32 | 0 |
| spring-boot-realworld-example-app | 2 | migrations ok 1/1; java ok 93/93 | 100% | 0 | 3/4 | – | 7/7 | 19/19 | 13/13 | 1/1 / 1/1 | 23/25 | 0 |
| spring-petclinic-kotlin | 3 | migrations ok 2/2; java ok 24/24 | 100% | 0 | – | 6/6 | 7/7 | 18/18 | 8/8 | 1/1 / 1/1 | 26/26 | 0 |
| piggymetrics | 2 | java ok 72/72 | 100% | 0 | – | – | – | 9/9 | 14/14 | 9/9 / 9/9 | 28/28 | 0 |
| killbill | 25 | migrations ok 84/84; java ok 1082/1082 | 100% | 0 | 8/10 | – | 63/63 | 100/100 | 12/12 | 2/2 / 2/2 | 26/27 | 0 |
| initializr | 6 | java ok 384/384 | 100% | 0 | 6/10 | – | – | 20/20 | 8/11 | 1/1 / 1/1 | 25/28 | 0 |
| jhipster-sample-app-gradle | 6 | migrations ok 7/7; java ok 78/78; typescript ok 188/188 | 100% | 0 | – | 6/6 | 9/9 | 39/39 | 15/15 | 2/2 / 2/2 | 34/35 | 0 |
| jhipster-sample-app-oauth2 | 5 | migrations ok 2/2; java ok 57/57; typescript ok 123/123 | 100% | 0 | – | 2/2 | 4/4 | 9/9 | 13/13 | 2/2 / 2/2 | 32/33 | 0 |
| spring-petclinic-angular | 1 | typescript ok 59/59 | 100% | 0 | 1/4 | – | – | – | 10/10 | 1/1 / 1/1 | 21/27 | 0 |
| analog | 4 | typescript ok 585/585 | 100% | 0 | 6/10 | – | – | – | 7/9 | 7/7 / 7/7 | 24/27 | 0 |
| spring-petclinic-rest | 3 | migrations ok 4/4; java ok 87/87 | 100% | 0 | 7/10 | 8/8 | 9/9 | 37/38 | 18/19 | 1/1 / 1/1 | 25/25 | 0 |
| nacos | 83 | migrations ok 9/9; java ok 3024/3024; typescript ok 205/205 | 100% | 0 | 5/10 | – | 16/16 | 75/75 | 6/10 | 10/10 / 10/10 | 25/26 | 0 |
| spring-cloud-gateway | 11 | java ok 392/392 | 100% | 0 | 8/10 | – | – | 3/3 | 12/12 | 4/4 / 4/4 | 32/32 | 0 |
| openmrs-core | 24 | migrations ok 41/49; java ok 877/877 | 100% | 0 | 6/10 | 86/86 | 100/100 | – | 9/10 | 1/1 / 1/1 | 27/27 | 0 |
| spring-boot-admin | 12 | migrations ok 0/20; java ok 242/242; typescript ok 140/140 | 100% | 0 | 5/10 | – | – | – | 10/10 | 9/9 / 9/9 | 25/26 | 0 |

## What was missed

### eladmin

- **risky files not in the top 10** (3): `eladmin-common/src/main/java/me/zhengjie/config/AsyncExecutor.java`, `eladmin-system/src/main/java/me/zhengjie/modules/system/service/dto/MenuDto.java`, `eladmin-system/src/main/java/me/zhengjie/AppRun.java`

### dubbo

- **risky files not in the top 10** (5): `dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/DescriptorUtils.java`, `dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/h12/grpc/GrpcHttp2ServerTransportListener.java`, `dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/frame/TriDecoder.java`, `dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/h12/http2/GenericHttp2ServerTransportListener.java`, `dubbo-remoting/dubbo-remoting-http12/src/main/java/org/apache/dubbo/remoting/http12/h2/Http2ServerChannelObserver.java`

### bitwarden-clients

- **risky files not in the top 10** (4): `libs/common/src/enums/feature-flag.enum.ts`, `apps/desktop/src/app/services/services.module.ts`, `apps/web/src/app/core/core.module.ts`, `apps/browser/src/popup/services/services.module.ts`
- **roles** (2): `libs/common/src/tools/extension/vendor/bitwarden.ts: labelled source, got vendored`, `.husky/pre-commit: labelled source, got other`

### spring-framework-petclinic

- **risky files not in the top 10** (1): `src/main/java/org/springframework/samples/petclinic/repository/jpa/JpaOwnerRepositoryImpl.java`
- **roles** (1): `src/main/webapp/WEB-INF/no-spring-config-files-there.txt: labelled other, got docs`

### spring-boot-realworld-example-app

- **risky files not in the top 10** (1): `src/main/java/io/spring/api/UsersApi.java`
- **roles** (2): `src/main/resources/mapper/ArticleMapper.xml: labelled source, got config`, `src/main/resources/mapper/UserMapper.xml: labelled source, got config`

### killbill

- **risky files not in the top 10** (2): `profiles/killbill/src/main/java/org/killbill/billing/server/listeners/KillbillGuiceListener.java`, `jaxrs/src/main/java/org/killbill/billing/jaxrs/resources/ExportResource.java`
- **roles** (1): `profiles/killbill/src/main/webapp/lib/swagger-ui-bundle.js: labelled vendored, got source`

### initializr

- **risky files not in the top 10** (4): `initializr-generator-spring/src/main/java/io/spring/initializr/generator/spring/properties/ApplicationProperties.java`, `initializr-web/src/main/java/io/spring/initializr/web/autoconfigure/InitializrAutoConfiguration.java`, `initializr-generator-spring/src/main/java/io/spring/initializr/generator/spring/build/maven/ConvertAnnotationProcessorsToPluginConfigBuildCustomizer.java`, `initializr-web/src/main/java/io/spring/initializr/web/project/MetadataProjectDescriptionCustomizer.java`
- **injections** (3): `io.spring.initializr.web.controller.CommandLineMetadataController -> io.spring.initializr.web.support.CommandLineHelpGenerator`, `io.spring.initializr.web.project.ProjectGenerationInvoker -> io.spring.initializr.web.project.ProjectRequestToDescriptionConverter`, `io.spring.initializr.web.project.DefaultProjectRequestToDescriptionConverter -> io.spring.initializr.web.project.ProjectRequestPlatformVersionTransformer`
- **roles** (3): `initializr-generator-test/src/main/java/io/spring/initializr/generator/test/InitializrMetadataTestBuilder.java: labelled test, got source`, `initializr-generator-test/src/main/java/io/spring/initializr/generator/test/io/TextTestUtils.java: labelled test, got source`, `initializr-generator/src/test/resources/project/build/gradle/sample-build.gradle: labelled test, got no role`

### jhipster-sample-app-gradle

- **roles** (1): `src/main/webapp/swagger-ui/index.html: labelled vendored, got source`

### jhipster-sample-app-oauth2

- **roles** (1): `src/main/webapp/swagger-ui/index.html: labelled vendored, got source`

### spring-petclinic-angular

- **risky files not in the top 10** (3): `src/app/specialties/specialty-list/specialty-list.component.ts`, `src/app/vets/vet-list/vet-list.component.ts`, `src/app/pettypes/pettype-list/pettype-list.component.ts`
- **roles** (6): `src/app/testing/dummy.component.ts: labelled test, got source`, `src/app/testing/router-stubs.ts: labelled test, got source`, `docs/index.html: labelled generated, got docs`, `docs/routes.html: labelled generated, got docs`, `docs/llms.txt: labelled generated, got docs`, `Dockerfile: labelled other, got config`

### analog

- **risky files not in the top 10** (4): `packages/platform/src/lib/platform-plugin.ts`, `packages/vite-plugin-angular/src/lib/utils/virtual-resources.ts`, `packages/vite-plugin-angular/src/lib/angular-vitest-plugin.ts`, `packages/vite-plugin-angular/src/lib/angular-jit-plugin.ts`
- **injections** (2): `apps/docs-analog/src/app/docs/components/locale-picker:LocalePicker -> packages/content/src/lib/content-locale:CONTENT_LOCALE`, `apps/docs-analog/src/app/docs/components/copy-page:CopyPage -> packages/content/src/lib/content-locale:CONTENT_LOCALE`
- **roles** (3): `packages/nx-plugin/src/generators/app/files/template-angular/src/main.server.ts__template__: labelled source, got other`, `libs/card/src/lib/autocomplete/__snapshots__/autocomplete.component.spec.ts.snap: labelled generated, got other`, `CHANGELOG.md: labelled generated, got docs`

### spring-petclinic-rest

- **risky files not in the top 10** (3): `src/main/java/org/springframework/samples/petclinic/service/ClinicService.java`, `src/main/java/org/springframework/samples/petclinic/rest/controller/v2/PetRestControllerV2.java`, `src/main/java/org/springframework/samples/petclinic/rest/controller/v2/OwnerRestControllerV2.java`
- **endpoints** (1): `GET /api/oops`
- **injections** (1): `org.springframework.samples.petclinic.repository.springdatajpa.SpringDataPetRepositoryImpl -> jakarta.persistence.EntityManager`

### nacos

- **risky files not in the top 10** (5): `ai/src/main/java/com/alibaba/nacos/ai/controller/SkillAdminController.java`, `console/src/main/java/com/alibaba/nacos/console/controller/v3/ai/ConsoleSkillController.java`, `console/src/main/java/com/alibaba/nacos/console/handler/impl/remote/ai/SkillRemoteHandler.java`, `ai/src/main/java/com/alibaba/nacos/ai/constant/Constants.java`, `console/src/main/java/com/alibaba/nacos/console/handler/impl/inner/ai/SkillInnerHandler.java`
- **injections** (4): `com.alibaba.nacos.bootstrap.NacosBootstrap -> com.alibaba.nacos.NacosServerBasicApplication`, `com.alibaba.nacos.bootstrap.NacosBootstrap -> com.alibaba.nacos.NacosServerWebApplication`, `com.alibaba.nacos.bootstrap.NacosBootstrap -> com.alibaba.nacos.console.NacosConsole`, `com.alibaba.nacos.bootstrap.NacosBootstrap -> com.alibaba.nacos.airegistry.NacosAiRegistry`
- **roles** (1): `plugin-default-impl/nacos-default-datasource-plugin/nacos-datasource-plugin-mysql/src/main/resources/META-INF/mysql-upgrade-visibility-permission-resource.sql: labelled migration, got source`

### spring-cloud-gateway

- **risky files not in the top 10** (2): `spring-cloud-gateway-server-webmvc/src/main/java/org/springframework/cloud/gateway/server/mvc/filter/Bucket4jFilterFunctions.java`, `spring-cloud-gateway-server-webflux/src/main/java/org/springframework/cloud/gateway/filter/FunctionRoutingFilter.java`

### openmrs-core

- **risky files not in the top 10** (4): `api/src/main/java/org/openmrs/util/ConceptReferenceRangeUtility.java`, `api/src/main/java/org/openmrs/api/context/UserContext.java`, `api/src/main/java/org/openmrs/api/impl/UserServiceImpl.java`, `api/src/main/java/org/openmrs/api/context/Daemon.java`
- **injections** (1): `org.openmrs.notification.impl.MessageServiceImpl -> org.openmrs.notification.db.TemplateDAO`

### spring-boot-admin

- **risky files not in the top 10** (5): `spring-boot-admin-server-ui/src/main/frontend/views/instances/details/health-details.vue`, `spring-boot-admin-server-ui/src/main/frontend/views/instances/details/details-info.vue`, `spring-boot-admin-server/src/main/java/de/codecentric/boot/admin/server/config/AdminServerAutoConfiguration.java`, `spring-boot-admin-server-ui/src/main/frontend/views/journal/JournalTable.vue`, `spring-boot-admin-server-ui/src/main/frontend/components/sba-button.vue`
- **roles** (1): `.gnupg.tar.enc: labelled other, got config`

